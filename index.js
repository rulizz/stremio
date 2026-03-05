const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const path = require("path");
const { login, search, debugSearch, invalidateSession } = require("./linkomanija");

const PORT = process.env.PORT || 3000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const DEBUG_ENABLED = process.env.DEBUG === "1" || process.env.DEBUG === "true";
const RD_API = "https://api.real-debrid.com/rest/1.0";
const VIDEO_EXTS = /\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|mpg|mpeg|ts)$/i;

const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
  ? Buffer.from(process.env.ENCRYPTION_KEY, "hex")
  : crypto.randomBytes(32);
if (!process.env.ENCRYPTION_KEY) {
  console.warn("[WARN] No ENCRYPTION_KEY — using random key. URLs won't survive restarts.");
  console.warn('[WARN] Generate: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
}

// ── IMDB → title ─────────────────────────────────────────────────────────────
async function getImdbTitle(imdbId, type) {
  try {
    const resp = await axios.get(`https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`, { timeout: 8000 });
    const meta = resp.data && resp.data.meta;
    if (!meta) return { title: null, year: null, ltTitle: null };

    let year = null;
    for (const field of [meta.year, meta.releaseInfo, meta.released]) {
      if (!year && field) { const m = String(field).match(/(\d{4})/); if (m) year = m[1]; }
    }

    let ltTitle = null;
    if (process.env.TMDB_API_KEY) {
      try {
        const tmdb = await axios.get(
          `https://api.themoviedb.org/3/find/${imdbId}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=lt`,
          { timeout: 5000 }
        );
        const results = tmdb.data.movie_results || tmdb.data.tv_results || [];
        if (results.length > 0) {
          if (results[0].title) ltTitle = results[0].title;
          if (!year) { const rd = results[0].release_date || results[0].first_air_date || ""; const m = rd.match(/(\d{4})/); if (m) year = m[1]; }
        }
      } catch (_) {}
    }
    console.log("[META] " + meta.name + " | year=" + year + (ltTitle ? " | lt=" + ltTitle : ""));
    return { title: meta.name || null, year, ltTitle };
  } catch (_) {
    return { title: null, year: null, ltTitle: null };
  }
}

// ── Credentials (AES-256-GCM) ────────────────────────────────────────────────
function encodeCredentials(username, password, rdKey, cats, sortBy, seriesCats) {
  const plaintext = JSON.stringify({ username, password, rdKey: rdKey || "", cats: cats || [61, 53], sortBy: sortBy || ["rd", "seeds", "size", "quality", "fl"], seriesCats: seriesCats || [28, 62] });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
}

function decodeCredentials(token) {
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 29) return null;
    const decipher = crypto.createDecipheriv("aes-256-gcm", ENCRYPTION_KEY, buf.slice(0, 12));
    decipher.setAuthTag(buf.slice(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(buf.slice(28)), decipher.final()]).toString("utf8"));
  } catch (_) {
    try { return JSON.parse(Buffer.from(token, "base64url").toString("utf8")); } catch (_) { return null; }
  }
}

// ── RD lock: prevent Stremio double-fire from creating duplicate torrents ────
const rdLocks = new Map();
async function withRdLock(key, fn) {
  while (rdLocks.has(key)) {
    try { await rdLocks.get(key); } catch (_) {}
  }
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  rdLocks.set(key, promise);
  try { return await fn(); }
  finally { rdLocks.delete(key); resolve(); }
}

// ── RD helpers ───────────────────────────────────────────────────────────────
function rdHeaders(rdKey) {
  return { Authorization: "Bearer " + rdKey, "Content-Type": "application/x-www-form-urlencoded" };
}

// Smart file selection: find the right file in a multi-file torrent (packs, season packs)
// Returns comma-separated file IDs to select, or "all" if unsure
function selectBestFiles(files, hint) {
  if (!hint || !files || files.length <= 1) return "all";
  const videos = files.filter(f => VIDEO_EXTS.test(f.path));
  if (videos.length <= 1) return "all";

  // Series: match SxxExx pattern
  if (hint.season && hint.episode) {
    const s = String(hint.season).padStart(2, "0");
    const e = String(hint.episode).padStart(2, "0");
    const pattern = new RegExp("S" + s + "E" + e, "i");
    const match = videos.find(f => pattern.test(f.path));
    if (match) {
      console.log("[RD] File select: S" + s + "E" + e + " → " + match.path);
      return String(match.id);
    }
  }

  // Movie: score each file by title words + year match
  if (hint.title) {
    const titleWords = hint.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
    const scored = videos.map(f => {
      const fp = f.path.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
      let score = 0;
      if (hint.year && fp.includes(hint.year)) score += 10;
      for (const w of titleWords) { if (fp.includes(w)) score += 2; }
      return { file: f, score };
    }).sort((a, b) => b.score - a.score);

    // Only select if best match is clearly better than second best (pack scenario)
    if (scored.length >= 2 && scored[0].score > scored[1].score && scored[0].score >= 4) {
      console.log("[RD] File select: " + scored[0].file.path + " (score=" + scored[0].score + ")");
      return String(scored[0].file.id);
    }
  }

  return "all"; // Can't determine — select everything, pickBestLink will find largest
}

// Pick the best link to unrestrict from a torrent's info (after files are selected)
function pickBestLink(info, hint) {
  if (!info.links || !info.links.length) return null;
  if (info.links.length === 1) return info.links[0];
  if (!info.files) return info.links[0];

  const selected = info.files.filter(f => f.selected === 1);
  if (selected.length !== info.links.length) return info.links[0];

  // Try hint-based matching first (same logic as selectBestFiles but on selected files)
  if (hint && selected.length > 1) {
    if (hint.season && hint.episode) {
      const pattern = new RegExp("S" + String(hint.season).padStart(2, "0") + "E" + String(hint.episode).padStart(2, "0"), "i");
      const idx = selected.findIndex(f => pattern.test(f.path));
      if (idx >= 0) return info.links[idx];
    }
    if (hint.title) {
      const titleWords = hint.title.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(w => w.length > 2);
      let bestIdx = -1, bestScore = 0;
      selected.forEach((f, idx) => {
        const fp = f.path.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
        let score = 0;
        if (hint.year && fp.includes(hint.year)) score += 10;
        for (const w of titleWords) { if (fp.includes(w)) score += 2; }
        if (score > bestScore && VIDEO_EXTS.test(f.path)) { bestScore = score; bestIdx = idx; }
      });
      if (bestIdx >= 0 && bestScore >= 4) return info.links[bestIdx];
    }
  }

  // Fallback: largest video file
  let bestIdx = 0, bestSize = 0;
  selected.forEach((f, idx) => { if (f.bytes > bestSize && VIDEO_EXTS.test(f.path)) { bestSize = f.bytes; bestIdx = idx; } });
  return info.links[bestIdx];
}

async function rdCheckUserTorrents(rdKey, infoHashes) {
  if (!infoHashes.length) return new Set();
  try {
    const resp = await axios.get(RD_API + "/torrents?limit=100", { headers: { Authorization: "Bearer " + rdKey }, timeout: 10000 });
    const hashSet = new Set(infoHashes.map(h => h.toLowerCase()));
    const ready = new Set();
    for (const t of resp.data || []) { const h = (t.hash || "").toLowerCase(); if (hashSet.has(h) && t.status === "downloaded") ready.add(h); }
    console.log("[RD] User torrents: " + ready.size + "/" + infoHashes.length + " ready");
    return ready;
  } catch (err) { console.error("[RD] User torrents error:", err.message); return new Set(); }
}

// Full RD resolve: check existing → add torrent → select files → poll → unrestrict
// fileHint = { title, year, season, episode } for smart file selection in packs
async function rdResolveStream(rdKey, magnet, userIp, torrentFileUrl, lmClient, fileHint) {
  const hdrs = rdHeaders(rdKey);
  const authOnly = { Authorization: "Bearer " + rdKey };
  let torrentId;
  const hashMatch = magnet.match(/btih:([a-f0-9]+)/i);
  const infoHash = hashMatch ? hashMatch[1].toLowerCase() : null;

  // Step 0: Check if torrent already exists in user's RD list
  if (infoHash) {
    try {
      const listResp = await axios.get(RD_API + "/torrents?limit=100", { headers: authOnly, timeout: 10000 });
      const existing = (listResp.data || []).find(t => (t.hash || "").toLowerCase() === infoHash);
      if (existing) {
        console.log("[RD] Existing id=" + existing.id + " status=" + existing.status);
        if (existing.status === "downloaded") {
          const info = await axios.get(RD_API + "/torrents/info/" + existing.id, { headers: authOnly, timeout: 10000 }).then(r => r.data);
          const link = pickBestLink(info, fileHint);
          if (link) {
            const dl = await axios.post(RD_API + "/unrestrict/link", "link=" + encodeURIComponent(link) + (userIp ? "&ip=" + encodeURIComponent(userIp) : ""), { headers: hdrs, timeout: 10000 }).then(r => r.data);
            if (dl && dl.download) { console.log("[RD] Fast path → " + dl.download.substring(0, 60) + "..."); return dl.download; }
          }
        }
        torrentId = existing.id;
      }
    } catch (err) { console.warn("[RD] Existing check error:", err.message); }
  }

  // Step 1: Add torrent — .torrent file FIRST (private tracker needs it), magnet fallback
  if (!torrentId) {
    // Try .torrent upload first for private tracker (RD can't find peers via DHT for LM)
    if (torrentFileUrl && lmClient) {
      try {
        console.log("[RD] Uploading .torrent file (private tracker)...");
        const torrentResp = await lmClient.get(torrentFileUrl, { responseType: "arraybuffer", timeout: 15000 });
        const addResp = await axios.put(RD_API + "/torrents/addTorrent", torrentResp.data, {
          headers: { Authorization: "Bearer " + rdKey, "Content-Type": "application/x-bittorrent" }, timeout: 15000,
        });
        torrentId = addResp.data.id;
        console.log("[RD] addTorrent → id=" + torrentId);
      } catch (err) {
        console.warn("[RD] addTorrent failed (" + (err.response ? err.response.status : "?") + "): " + (err.response ? JSON.stringify(err.response.data).substring(0, 100) : err.message));
      }
    }

    // Fallback to magnet (works for public trackers or if .torrent download failed)
    if (!torrentId) {
      try {
        const addResp = await axios.post(RD_API + "/torrents/addMagnet", "magnet=" + encodeURIComponent(magnet), { headers: hdrs, timeout: 15000 });
        torrentId = addResp.data.id;
        console.log("[RD] addMagnet → id=" + torrentId);
      } catch (err) {
        console.error("[RD] addMagnet failed (" + (err.response ? err.response.status : "?") + ")");
        throw new Error("RD: both .torrent and magnet failed");
      }
    }
  }
  if (!torrentId) throw new Error("RD: no torrent ID");

  // Step 2: Get file list, then smart-select files
  // First get info to see file list (before selecting)
  let preInfo;
  try {
    preInfo = await axios.get(RD_API + "/torrents/info/" + torrentId, { headers: authOnly, timeout: 10000 }).then(r => r.data);
  } catch (_) {}

  const filesToSelect = preInfo && preInfo.files ? selectBestFiles(preInfo.files, fileHint) : "all";
  console.log("[RD] Selecting files: " + filesToSelect + (filesToSelect !== "all" ? " (smart)" : ""));
  await axios.post(RD_API + "/torrents/selectFiles/" + torrentId, "files=" + filesToSelect, { headers: hdrs, timeout: 10000 });

  // Step 3: Poll for links
  let info;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 1000 : 2000));
    info = await axios.get(RD_API + "/torrents/info/" + torrentId, { headers: authOnly, timeout: 10000 }).then(r => r.data);
    console.log("[RD] poll " + (i + 1) + " status=" + info.status);
    if (info.links && info.links.length > 0) break;
    if (["error", "dead", "magnet_error", "virus"].includes(info.status)) throw new Error("RD torrent failed: " + info.status);
  }
  if (!info || !info.links || !info.links.length) throw new Error("RD: no links (" + (info ? info.status : "none") + ")");

  // Step 4: Unrestrict best link
  const body = "link=" + encodeURIComponent(pickBestLink(info, fileHint)) + (userIp ? "&ip=" + encodeURIComponent(userIp) : "");
  let unrestricted;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { unrestricted = await axios.post(RD_API + "/unrestrict/link", body, { headers: hdrs, timeout: 10000 }).then(r => r.data); break; }
    catch (err) { if (attempt === 0 && err.response && err.response.status === 503) { await new Promise(r => setTimeout(r, 2000)); continue; } throw err; }
  }
  if (!unrestricted || !unrestricted.download) throw new Error("RD unrestrict: no download URL");
  console.log("[RD] Resolved → " + unrestricted.download.substring(0, 60) + "...");
  return unrestricted.download;
}

// ── Utilities ────────────────────────────────────────────────────────────────
function getUserIp(req) { return req.headers["x-forwarded-for"] ? req.headers["x-forwarded-for"].split(",")[0].trim() : req.ip; }

function extractInfoHash(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const marker = Buffer.from("4:info");
  const infoStart = buf.indexOf(marker);
  if (infoStart === -1) throw new Error("No info dict in torrent");
  const start = infoStart + marker.length;
  let depth = 0, i = start;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === 100 || ch === 108) { depth++; i++; }
    else if (ch === 101) { depth--; i++; if (depth === 0) break; }
    else if (ch >= 48 && ch <= 57) { let e = i; while (e < buf.length && buf[e] !== 58) e++; i = e + 1 + parseInt(buf.slice(i, e).toString(), 10); }
    else if (ch === 105) { let e = buf.indexOf(101, i + 1); if (e === -1) break; i = e + 1; }
    else { i++; }
  }
  return crypto.createHash("sha1").update(buf.slice(start, i)).digest("hex");
}

function buildMagnet(infoHash, name, passkey) {
  const trackers = ["udp://tracker.opentrackr.org:1337/announce", "udp://open.tracker.cl:1337/announce", "udp://tracker.openbittorrent.com:6969/announce"];
  if (passkey) trackers.unshift("http://tracker.linkomanija.net:2710/" + passkey + "/announce");
  return "magnet:?xt=urn:btih:" + infoHash + "&dn=" + encodeURIComponent(name || infoHash) + trackers.map(t => "&tr=" + encodeURIComponent(t)).join("");
}

function parseSize(s) {
  if (!s) return 0;
  const m = s.replace(/,/g, "").match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  return m ? parseFloat(m[1]) * ({ TB: 1e12, GB: 1e9, MB: 1e6, KB: 1e3 }[m[2].toUpperCase()] || 1) : 0;
}

const QUALITY_SCORE = s => {
  if (!s) return 0; const u = s.toUpperCase();
  return (u.includes("4K") || u.includes("2160")) ? 5 : u.includes("1080") && u.includes("BLU") ? 4 : u.includes("1080") ? 3 : u.includes("720") ? 2 : u.includes("WEB") ? 1.5 : 1;
};

function esc(str) { return str ? String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;") : ""; }

// ── Pack / franchise detection ───────────────────────────────────────────────
// Extract broader franchise name from a movie title for pack searches
// "Harry Potter and the Goblet of Fire" → "Harry Potter"
// "Avengers: Age of Ultron" → "Avengers"
// "Star Wars: Episode IV" → "Star Wars"
function extractFranchise(title) {
  // "Star Wars: Episode IV" → "Star Wars"
  for (const sep of [": ", " - "]) {
    const idx = title.indexOf(sep);
    if (idx > 3) { const first = title.substring(0, idx).trim(); if (first.split(/\s+/).length >= 2) return first; }
  }
  // "Harry Potter and the Goblet of Fire" → "Harry Potter"
  const andThe = title.match(/^((?:\S+\s+){1,3}\S+)\s+and\s+the\s+/i);
  if (andThe) { const f = andThe[1].trim(); if (f.split(/\s+/).length >= 2) return f; }
  // "Shrek 2" → "Shrek", "Iron Man 3" → "Iron Man"
  const noNum = title.replace(/\s+\d+\s*$/, "").trim();
  if (noNum !== title && noNum.length > 3) return noNum;
  return null;
}

// ── Build stream list ────────────────────────────────────────────────────────
// Now includes fileHint params (t,y,s,e) in rd-stream URL for smart file selection
function buildStreams(torrents, title, sortBy, token, hasRdKey, fileHint) {
  const order = Array.isArray(sortBy) ? sortBy : ["rd", "seeds", "size", "quality", "fl"];
  const entries = [];
  const hintParams = fileHint ? "&t=" + encodeURIComponent(fileHint.title || "") + "&y=" + (fileHint.year || "") + "&s=" + (fileHint.season || "") + "&e=" + (fileHint.episode || "") : "";

  for (const t of torrents) {
    if (!t.magnet) continue;
    const base = { _seeds: t.seeders || 0, _size: parseSize(t.size), _quality: QUALITY_SCORE(t.quality), _fl: t.freeleech ? 1 : 0 };
    const meta = (t.size || "?") + " │ S:" + t.seeders + " L:" + t.leechers;
    const flTag = t.freeleech ? " 🟢FL" : "";
    const packTag = t.isPack ? " 📦" : "";

    if (hasRdKey && t.infoHash && token) {
      const ready = t.rdReady;
      entries.push({ ...base, _rd: ready ? 3 : 1,
        name: (ready ? "⚡" : "📥") + " LM" + packTag + " RD\n" + t.quality + flTag,
        description: t.name + "\n" + meta + "\n" + (ready ? "⚡ In your RD library" : "📥 Click to add to Real-Debrid"),
        url: ADDON_URL + "/rd-stream/" + token + "/" + t.infoHash + "/" + encodeURIComponent(t.name) + "?tid=" + (t.id || "") + hintParams,
        behaviorHints: { bingeGroup: "lm-rd-" + title, notWebReady: true },
      });
    }
    entries.push({ ...base, _rd: 0,
      name: "🇱🇹 LM" + packTag + " Magnet\n" + t.quality + flTag,
      description: t.name + "\n" + meta,
      url: t.magnet, behaviorHints: { bingeGroup: "lm-p2p-" + title },
    });
  }
  entries.sort((a, b) => {
    for (const k of order) {
      const d = k === "rd" ? (b._rd || 0) - (a._rd || 0) : k === "seeds" ? b._seeds - a._seeds : k === "size" ? b._size - a._size : k === "quality" ? b._quality - a._quality : k === "fl" ? b._fl - a._fl : 0;
      if (d !== 0) return d;
    } return 0;
  });
  return entries.map(({ _rd, _seeds, _size, _quality, _fl, ...s }) => s);
}

// ── Resolve magnets ──────────────────────────────────────────────────────────
async function resolveMagnets(session, torrents) {
  const results = [...torrents];
  for (let i = 0; i < results.length; i += 5) {
    await Promise.all(results.slice(i, i + 5).map(async t => {
      try {
        let dlUrl = "https://www.linkomanija.net/download.php?id=" + t.id;
        if (session.passkey) dlUrl += "&passkey=" + session.passkey;
        const resp = await session.client.get(dlUrl, {
          responseType: "arraybuffer", maxRedirects: 10, timeout: 15000,
          headers: { Accept: "application/x-bittorrent, application/octet-stream, */*", Referer: "https://www.linkomanija.net/browse.php" },
        });
        const data = Buffer.from(resp.data);
        if ((resp.headers["content-type"] || "").includes("text/html") || data.length < 100) return;
        const hash = extractInfoHash(data);
        t.infoHash = hash.toLowerCase();
        t.magnet = buildMagnet(hash, t.name, session.passkey);
        console.log("[MAGNET] id=" + t.id + " hash=" + hash.substring(0, 8) + "...");
      } catch (err) { console.warn("[MAGNET] id=" + t.id + " failed: " + err.message); }
    }));
  }
  return results;
}


// ── Express ──────────────────────────────────────────────────────────────────
const app = express();
app.set("trust proxy", true);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => { res.header("Access-Control-Allow-Origin", "*"); res.header("Access-Control-Allow-Headers", "*"); next(); });

app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => res.send(configurePage()));

app.post("/configure", (req, res) => {
  const { username, password, rdKey, cats, seriesCats, sortBy } = req.body;
  if (!username || !password) return res.send(configurePage("Username and password are required."));
  const catList = (cats || "61,53").split(",").map(c => parseInt(c.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  const seriesCatList = (seriesCats || "28,62").split(",").map(c => parseInt(c.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  const sortList = (sortBy || "rd,seeds,size,quality,fl").split(",").map(s => s.trim()).filter(Boolean);
  const token = encodeCredentials(username.trim(), password, (rdKey || "").trim(), catList, sortList, seriesCatList);
  const manifestUrl = ADDON_URL + "/" + token + "/manifest.json";
  const stremioUrl = "stremio://" + new URL(ADDON_URL).host + "/" + token + "/manifest.json";
  res.send(successPage(manifestUrl, stremioUrl, username.trim()));
});

app.get("/:token/manifest.json", (req, res) => {
  const creds = decodeCredentials(req.params.token);
  if (!creds) return res.status(400).json({ error: "Invalid token" });
  res.json({
    id: "community.linkomanija." + creds.username, version: "1.3.0",
    name: "\u{1f1f1}\u{1f1f9} Linkomanija (" + creds.username + ")",
    description: "Streams from Linkomanija.net private tracker.",
    logo: "https://www.linkomanija.net/favicon.ico",
    resources: ["stream"], types: ["movie", "series"], catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
    configureUrl: ADDON_URL + "/configure",
  });
});

// ── Stream handler ───────────────────────────────────────────────────────────
app.get("/:token/stream/:type/:id.json", async (req, res) => {
  const startTime = Date.now();
  const { token, type, id } = req.params;
  const creds = decodeCredentials(token);
  if (!creds) return res.json({ streams: [] });

  const [imdbId, season, episode] = id.split(":");
  console.log("[STREAM] " + type + " | " + id + " | " + creds.username);

  try {
    const session = await login(creds.username, creds.password);
    const { title, year, ltTitle } = await getImdbTitle(imdbId, type);
    if (!title) { console.warn("[IMDB] No title for " + imdbId); return res.json({ streams: [] }); }
    console.log("[IMDB] " + title + (year ? " (" + year + ")" : "") + (ltTitle ? " / LT: " + ltTitle : ""));

    const cats = type === "series" ? (creds.seriesCats || [28, 62]) : (creds.cats || [61, 53]);
    const sortBy = Array.isArray(creds.sortBy) ? creds.sortBy : (creds.sortBy || "seeds").split(",");

    // Build search queries — most specific first, fall back to broader
    const queries = [];
    if (type === "series" && season && episode) {
      const s = String(season).padStart(2, "0"), e = String(episode).padStart(2, "0");
      queries.push(title + " S" + s + "E" + e);
      if (ltTitle && ltTitle !== title) queries.push(ltTitle + " S" + s + "E" + e);
      queries.push(title + " S" + s);
      if (ltTitle && ltTitle !== title) queries.push(ltTitle + " S" + s);
    }
    if (year) queries.push(title + " " + year);
    if (ltTitle && ltTitle !== title && year) queries.push(ltTitle + " " + year);
    queries.push(title);
    if (ltTitle && ltTitle !== title) queries.push(ltTitle);

    const searchYear = type === "movie" ? year : null;
    let results = [];
    for (const query of queries) {
      results = await search(session, query, type, cats, searchYear);
      console.log("[STREAM] " + results.length + " results for: " + query);
      if (results.length > 0) break;
    }

    // Pack search: also search for franchise/broader name to find packs
    // e.g. "Harry Potter and the Goblet of Fire" -> also search "Harry Potter"
    const seenIds = new Set(results.map(r => r.id));
    const franchise = extractFranchise(title);
    if (franchise && franchise.toLowerCase() !== title.toLowerCase()) {
      try {
        const packResults = await search(session, franchise, type, cats);
        let packCount = 0;
        for (const pr of packResults) {
          if (!seenIds.has(pr.id)) {
            // Only include if it looks like a pack (large size or name suggests collection)
            const n = pr.name.toLowerCase();
            const isPack = n.includes("pack") || n.includes("collection") || n.includes("complete") ||
              n.includes("saga") || n.includes("anthology") || n.includes("boxset") || n.includes("box set") ||
              n.includes("1-") || n.includes("i-") || /\d{4}\s*[-–]\s*\d{4}/.test(n); // year range like "2001-2011"
            if (isPack) {
              pr.isPack = true;
              results.push(pr);
              seenIds.add(pr.id);
              packCount++;
            }
          }
        }
        if (packCount > 0) console.log("[STREAM] Found " + packCount + " packs from franchise search: " + franchise);
      } catch (_) {}
    }

    // Also try for series: broader show name search for season packs
    if (type === "series" && season) {
      try {
        const showResults = await search(session, title, type, cats);
        for (const sr of showResults) {
          if (!seenIds.has(sr.id)) {
            const n = sr.name.toLowerCase();
            const hasSeason = new RegExp("s" + String(season).padStart(2, "0"), "i").test(n);
            const isPack = n.includes("pack") || n.includes("complete") || n.includes("season") || n.includes("collection");
            if (hasSeason && isPack) {
              sr.isPack = true;
              results.push(sr);
              seenIds.add(sr.id);
            }
          }
        }
      } catch (_) {}
    }

    const withMagnets = await resolveMagnets(session, results.slice(0, 15));
    if (creds.rdKey) {
      const hashes = withMagnets.filter(t => t.infoHash).map(t => t.infoHash);
      if (hashes.length > 0) {
        const readySet = await rdCheckUserTorrents(creds.rdKey, hashes);
        for (const t of withMagnets) { if (t.infoHash && readySet.has(t.infoHash)) t.rdReady = true; }
      }
    }

    // Pass file hint so rd-stream URL includes title/year/season/episode for smart file selection
    const fileHint = { title, year, season, episode };
    const streams = buildStreams(withMagnets, title, sortBy, token, !!creds.rdKey, fileHint);
    console.log("[STREAM] " + streams.length + " streams (" + (Date.now() - startTime) + "ms)");
    res.json({ streams });
  } catch (err) {
    console.error("[STREAM ERROR]", err.message);
    if (err.message && err.message.toLowerCase().includes("login")) invalidateSession(creds.username);
    res.json({ streams: [] });
  }
});

// ── RD Stream (resolve on click -> 302 redirect) ────────────────────────────
// Uses withRdLock to prevent Stremio double-fire from adding duplicate torrents
app.get("/rd-stream/:token/:infoHash/:name?", async (req, res) => {
  const { token, infoHash } = req.params;
  const name = req.params.name ? decodeURIComponent(req.params.name) : "video";
  const torrentId = req.query.tid || "";
  const creds = decodeCredentials(token);
  if (!creds || !creds.rdKey) return res.status(401).send("Invalid token or no RD key");

  const userIp = getUserIp(req);
  // Parse file hint from query params (for smart file selection in packs)
  const fileHint = {
    title: req.query.t ? decodeURIComponent(req.query.t) : null,
    year: req.query.y || null,
    season: req.query.s || null,
    episode: req.query.e || null,
  };
  console.log("[RD-STREAM] hash=" + infoHash.substring(0, 8) + "... ip=" + userIp + " tid=" + torrentId + (fileHint.title ? " hint=" + fileHint.title : ""));

  // Lock per hash+user to prevent duplicate adds from Stremio double-fire
  const lockKey = infoHash + "-" + creds.rdKey.substring(0, 8);
  try {
    const directUrl = await withRdLock(lockKey, async () => {
      let passkey = "", session = null;
      try { session = await login(creds.username, creds.password); passkey = session.passkey; } catch (_) {}
      const magnet = buildMagnet(infoHash, name, passkey);
      const torrentDlUrl = (session && torrentId) ? "https://www.linkomanija.net/download.php?id=" + torrentId + "&passkey=" + passkey : null;
      return rdResolveStream(creds.rdKey, magnet, userIp, torrentDlUrl, session ? session.client : null, fileHint);
    });
    console.log("[RD-STREAM] \u2713 Redirecting");
    return res.redirect(302, directUrl);
  } catch (err) {
    console.error("[RD-STREAM] \u2717", err.message);
    if (err.message.includes("no links") || err.message.includes("still") || err.message.includes("failed")) {
      return res.sendFile(path.join(__dirname, "caching.mp4"));
    }
    let passkey = "";
    try { const s = await login(creds.username, creds.password); passkey = s.passkey; } catch (_) {}
    return res.redirect(302, buildMagnet(infoHash, name, passkey));
  }
});


// ── Debug endpoints (DEBUG=1) ────────────────────────────────────────────────
if (DEBUG_ENABLED) {
  app.get("/proxy-test/:token/:torrentId", async (req, res) => {
    const { token, torrentId } = req.params;
    const creds = decodeCredentials(token);
    if (!creds) return res.send("Invalid token");
    try {
      const session = await login(creds.username, creds.password);
      let dlUrl = "https://www.linkomanija.net/download.php?id=" + torrentId;
      if (session.passkey) dlUrl += "&passkey=" + session.passkey;
      const resp = await session.client.get(dlUrl, {
        responseType: "arraybuffer", maxRedirects: 10,
        headers: { Accept: "application/x-bittorrent, */*", Referer: "https://www.linkomanija.net/browse.php" },
      });
      const data = Buffer.from(resp.data);
      const ct = resp.headers["content-type"] || "unknown";
      const isHtml = ct.includes("html") || data.toString("utf8", 0, 100).includes("<html");
      const isValid = data.length > 200 && !isHtml;
      let hash = "";
      if (isValid) { try { hash = extractInfoHash(data); } catch (e) { hash = "error: " + e.message; } }
      res.send(`<!DOCTYPE html><html><head><style>body{font-family:monospace;background:#111;color:#eee;padding:20px}.good{color:#22c55e}.bad{color:#f87171}table{border-collapse:collapse;margin:1rem 0}td{padding:6px 12px;border:1px solid #333}</style></head><body>
        <h2 style="color:#f5a623">Proxy Test id=${esc(torrentId)}</h2><table>
        <tr><td>URL</td><td>${esc(dlUrl)}</td></tr><tr><td>Content-Type</td><td>${esc(ct)}</td></tr>
        <tr><td>Size</td><td>${data.length} bytes</td></tr><tr><td>Passkey</td><td>${session.passkey ? "YES " + session.passkey.substring(0, 8) + "..." : "NOT FOUND"}</td></tr>
        <tr><td>Hash</td><td class="${hash.length === 40 ? "good" : "bad"}">${esc(hash) || "n/a"}</td></tr>
        <tr><td>Verdict</td><td class="${isValid ? "good" : "bad"}">${isValid ? "VALID" : "HTML/EMPTY"}</td></tr>
        </table></body></html>`);
    } catch (err) { res.send("<b style='color:red'>" + esc(err.message) + "</b>"); }
  });

  app.get("/debug", async (req, res) => {
    const { token, query, type } = req.query;
    if (!token || !query) {
      return res.send(`<!DOCTYPE html><html><head><style>body{font-family:monospace;background:#111;color:#eee;padding:20px}input,select{background:#222;color:#eee;border:1px solid #444;padding:8px;margin:8px 0;display:block;width:400px}button{background:#e8342a;color:#fff;border:none;padding:10px 20px;cursor:pointer;margin-top:8px}</style></head><body>
        <h2 style="color:#f5a623">LM Debug</h2><form>
        <label>Token</label><input name="token" value="${esc(token || "")}"/>
        <label>Query</label><input name="query" value="${esc(query || "")}"/>
        <label>Type</label><select name="type"><option value="movie"${type === "movie" ? " selected" : ""}>movie</option><option value="series"${type === "series" ? " selected" : ""}>series</option></select>
        <button type="submit">Run</button></form></body></html>`);
    }
    const creds = decodeCredentials(token);
    if (!creds) return res.send("<b style='color:red'>Invalid token</b>");
    try {
      const session = await login(creds.username, creds.password);
      const { html, url } = await debugSearch(session, query);
      const $ = require("cheerio").load(html);
      const rows = $('tr:has(a[href*="download.php"])');
      const tdInfo = [];
      if (rows.length > 0) rows.first().find("td").each((i, td) => { tdInfo.push("td[" + i + "] = " + $(td).text().trim().substring(0, 50)); });
      res.send(`<!DOCTYPE html><html><head><style>body{font-family:monospace;background:#111;color:#eee;padding:20px}h2{color:#f5a623}h3{color:#22c55e;margin-top:1.5rem}pre{background:#1a1a1a;border:1px solid #333;padding:12px;white-space:pre-wrap;word-break:break-all}.good{color:#22c55e}.bad{color:#f87171}a{color:#60a5fa}</style></head><body>
        <h2>Debug: ${esc(query)}</h2><p><a href="${esc(url)}">${esc(url)}</a> (${html.length} bytes)</p>
        <h3>Rows</h3><p class="${rows.length > 0 ? "good" : "bad"}">rows with download links: ${rows.length}</p>
        <h3>First row cells</h3><pre>${esc(tdInfo.join("\n"))}</pre>
        <h3>First row HTML</h3><pre>${esc((rows.length > 0 ? $.html(rows.first()) : "").substring(0, 4000))}</pre>
        </body></html>`);
    } catch (err) { res.send("<b style='color:red'>" + esc(err.message) + "</b>"); }
  });

  app.get("/debug-rows/:token/:query", async (req, res) => {
    const { token, query } = req.params;
    const creds = decodeCredentials(token);
    if (!creds) return res.send("Invalid token");
    try {
      const session = await login(creds.username, creds.password);
      const { html } = await debugSearch(session, decodeURIComponent(query));
      const $ = require("cheerio").load(html);
      const rows = $('tr:has(a[href*="download.php"])');
      let out = `<h2>${rows.length} rows for "${esc(decodeURIComponent(query))}"</h2>`;
      rows.each((i, row) => {
        const $r = $(row), hrefs = [];
        $r.find("a").each((_, a) => { const h = $(a).attr("href") || ""; if (h && !h.startsWith("#") && !h.startsWith("javascript")) hrefs.push(h.substring(0, 80)); });
        out += `<div style="border:1px solid #333;margin:10px 0;padding:10px"><b>Row ${i}</b> | cells: ${$r.find("td").length} | dl: ${$r.find('a[href*="download.php"]').length}<br>
          <b>Name:</b> ${esc($r.find("a b").first().text().trim().substring(0, 80))}<br><pre>${esc(hrefs.join("\n"))}</pre></div>`;
      });

      res.send(`<!DOCTYPE html><html><head><style>body{font-family:monospace;background:#111;color:#eee;padding:20px;font-size:12px}pre{background:#1a1a1a;padding:8px;white-space:pre-wrap}h2{color:#f5a623}b{color:#60a5fa}</style></head><body>${out}</body></html>`);
    } catch (err) { res.send("<b style='color:red'>" + esc(err.message) + "</b>"); }
  });
  console.log("[DEBUG] Endpoints enabled (/debug, /debug-rows, /proxy-test)");
}

app.get("/health", (req, res) => res.json({ status: "ok", addonUrl: ADDON_URL, debug: DEBUG_ENABLED }));
app.listen(PORT, () => { console.log("Linkomanija addon on port " + PORT + " | " + ADDON_URL + "/configure"); });


// ── HTML pages ───────────────────────────────────────────────────────────────
function configurePage(error) {
  error = error || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Linkomanija · Stremio Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0b0d0f;--surface:#13161a;--card:#161a1f;--border:#1e2328;--accent:#e8342a;--accent2:#f5a623;--green:#22c55e;--text:#e8e6e1;--muted:#6b7280}
    body{background:var(--bg);color:var(--text);font-family:"DM Sans",sans-serif;min-height:100vh;display:flex;align-items:flex-start;justify-content:center;padding:2rem}
    body::before{content:"";position:fixed;top:-20%;left:-10%;width:55%;height:55%;background:radial-gradient(ellipse,rgba(232,52,42,.1) 0%,transparent 70%);pointer-events:none;z-index:0}
    .wrap{position:relative;z-index:1;width:100%;max-width:560px;animation:fadeUp .45s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

    .header{display:flex;align-items:center;gap:1rem;margin-bottom:2rem}
    .header h1{font-family:"Bebas Neue",sans-serif;font-size:2.4rem;letter-spacing:.06em;line-height:1}
    .header p{font-size:.75rem;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-top:3px}

    .section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-bottom:1rem}
    .section-title{font-size:.65rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem}
    .section-title::after{content:"";flex:1;height:1px;background:var(--border)}

    .field{margin-bottom:1rem}
    .field:last-child{margin-bottom:0}
    .field label{display:block;font-size:.72rem;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:.45rem}
    .field label span{text-transform:none;font-weight:300;letter-spacing:0;color:#4b5563}
    input[type=text],input[type=password]{width:100%;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.8rem 1rem;color:var(--text);font-family:"DM Sans",sans-serif;font-size:.9rem;outline:none;transition:border-color .2s,box-shadow .2s}
    input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,52,42,.12)}
    input::placeholder{color:#2e333a}

    .cat-list{display:flex;flex-direction:column;gap:.5rem;margin-bottom:.75rem}
    .cat-row{display:flex;align-items:center;gap:.5rem}
    .cat-row input[type=number]{width:90px;padding:.55rem .75rem;font-size:.85rem;flex-shrink:0}
    .cat-row input[type=text]{flex:1;padding:.55rem .75rem;font-size:.85rem}
    .cat-row .del{background:transparent;border:1px solid #2e333a;border-radius:6px;color:var(--muted);width:32px;height:32px;cursor:pointer;font-size:1rem;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:border-color .2s,color .2s}
    .cat-row .del:hover{border-color:#f87171;color:#f87171}
    .add-cat{background:transparent;border:1px dashed #2e333a;border-radius:8px;color:var(--muted);font-size:.8rem;padding:.55rem 1rem;cursor:pointer;width:100%;transition:border-color .2s,color .2s;font-family:"DM Sans",sans-serif}
    .add-cat:hover{border-color:var(--accent2);color:var(--accent2)}
    .cat-hint{font-size:.72rem;color:#3d4450;margin-top:.5rem;line-height:1.5}
    .cat-hint a{color:#4b5563;text-decoration:none}
    .cat-hint a:hover{color:var(--accent2)}

    .sort-list{display:flex;flex-direction:column;gap:.4rem;margin-bottom:.5rem}
    .sort-item{display:flex;align-items:center;gap:.75rem;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.65rem .9rem;cursor:grab;user-select:none;transition:border-color .2s,background .15s}
    .sort-item:active{cursor:grabbing}
    .sort-item.dragging{opacity:.4}
    .sort-item.drag-over{border-color:var(--accent2);background:#161200}
    .sort-handle{color:#2e333a;font-size:1rem;flex-shrink:0}
    .sort-badge{font-size:.7rem;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:2px 7px;border-radius:4px;flex-shrink:0}
    .badge-rd{background:rgba(34,197,94,.15);color:var(--green)}
    .badge-seeds{background:rgba(96,165,250,.15);color:#60a5fa}
    .badge-size{background:rgba(167,139,250,.15);color:#a78bfa}
    .badge-quality{background:rgba(245,166,35,.15);color:var(--accent2)}
    .badge-fl{background:rgba(232,52,42,.15);color:var(--accent)}
    .sort-desc{font-size:.8rem;color:var(--text);flex:1}
    .sort-subdesc{font-size:.7rem;color:var(--muted);margin-top:1px}
    .sort-hint{font-size:.72rem;color:#3d4450;margin-top:.4rem}

    .submit-btn{width:100%;background:var(--accent);color:#fff;border:none;border-radius:10px;padding:1rem;font-family:"Bebas Neue",sans-serif;font-size:1.15rem;letter-spacing:.1em;cursor:pointer;transition:background .2s;margin-top:.5rem}
    .submit-btn:hover{background:#c42720}
    .error-box{background:rgba(232,52,42,.08);border:1px solid rgba(232,52,42,.25);border-radius:8px;padding:.75rem 1rem;font-size:.85rem;color:#f87171;margin-bottom:1rem}
    .note{font-size:.75rem;color:#3d4450;text-align:center;margin-top:1rem;line-height:1.7}
    .note a{color:#4b5563;text-decoration:none}
    .note a:hover{color:var(--accent2)}
  </style>
</head>
<body>
<div class="wrap">
  <div class="header">
    <span style="font-size:2.5rem">🇱🇹</span>
    <div><h1>Linkomanija</h1><p>Stremio Addon · Configure</p></div>
  </div>

  ${error ? '<div class="error-box">⚠ ' + esc(error) + "</div>" : ""}

  <form method="POST" action="/configure" onsubmit="prepareForm(event)">

    <div class="section">
      <div class="section-title">Account</div>
      <div class="field">
        <label>Linkomanija Username</label>
        <input type="text" name="username" placeholder="your_username" autocomplete="username" required/>
      </div>
      <div class="field">
        <label>Password</label>
        <input type="password" name="password" placeholder="••••••••" autocomplete="current-password" required/>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Real-Debrid <span style="text-transform:none;font-weight:300;letter-spacing:0;color:#3d4450;font-size:.6rem;margin-left:.25rem">— optional</span></div>
      <div class="field">
        <label>API Key <span>— enables instant streaming via Real-Debrid</span></label>
        <input type="text" name="rdKey" placeholder="Get yours at real-debrid.com/apitoken"/>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Movie Categories</div>
      <div class="cat-list" id="catList"></div>
      <button type="button" class="add-cat" onclick="addCat('catList')">+ Add category</button>
      <input type="hidden" name="cats" id="catsInput"/>
    </div>

    <div class="section">
      <div class="section-title">Series Categories</div>
      <div class="cat-list" id="seriesCatList"></div>
      <button type="button" class="add-cat" onclick="addCat('seriesCatList')">+ Add category</button>
      <input type="hidden" name="seriesCats" id="seriesCatsInput"/>
      <p class="cat-hint">
        Find category IDs by browsing <a href="https://www.linkomanija.net/browse.php" target="_blank">linkomanija.net/browse.php</a>
        — the number after <code>cat=</code> in the URL is the ID.
      </p>
    </div>

    <div class="section">
      <div class="section-title">Stream Sort Order</div>
      <p style="font-size:.78rem;color:var(--muted);margin-bottom:.75rem">Drag to reorder — top item sorts first</p>
      <div class="sort-list" id="sortList"></div>
      <input type="hidden" name="sortBy" id="sortByInput"/>
      <p class="sort-hint">Drag the criteria into the priority order you prefer. All enabled criteria are used — first one breaks ties with the next.</p>
    </div>

    <button type="submit" class="submit-btn">Generate My Addon URL →</button>
  </form>

  <p class="note">
    Credentials are encrypted in your URL — never stored on this server.<br/>
    <a href="https://www.linkomanija.net" target="_blank">linkomanija.net</a> account required.
  </p>
</div>

<script>
const DEFAULT_CATS = [
  { id: 61, label: "Movies LT" },
  { id: 53, label: "Movies EN" },
];
const DEFAULT_SERIES_CATS = [
  { id: 62, label: "Series LT" },
  { id: 28, label: "Series EN" },
];

function addCat(listId, id, label) {
  const list = document.getElementById(listId);
  const row = document.createElement("div");
  row.className = "cat-row";
  row.innerHTML =
    "<input type='number' placeholder='ID' value='" + (id || "") + "' min='1' max='999'/>" +
    "<input type='text' placeholder='Label (optional)' value='" + (label || "") + "'/>" +
    "<button type='button' class='del' onclick='this.parentElement.remove()' title='Remove'>×</button>";
  list.appendChild(row);
}

DEFAULT_CATS.forEach(c => addCat("catList", c.id, c.label));
DEFAULT_SERIES_CATS.forEach(c => addCat("seriesCatList", c.id, c.label));

const SORT_CRITERIA = [
  { key: "rd",      badge: "RD",      badgeClass: "badge-rd",      label: "Real-Debrid first",  sub: "Cached/direct streams appear above magnet fallbacks" },
  { key: "seeds",   badge: "Seeds",   badgeClass: "badge-seeds",   label: "Most seeders",       sub: "Higher seed count = more reliable download" },
  { key: "size",    badge: "Size",    badgeClass: "badge-size",    label: "Largest file",       sub: "Bigger file usually means better quality" },
  { key: "quality", badge: "Quality", badgeClass: "badge-quality", label: "Best quality",       sub: "4K > 1080p > 720p > SD" },
  { key: "fl",      badge: "FL",      badgeClass: "badge-fl",      label: "Freeleech first",    sub: "Freeleech torrents don't count against your ratio" },
];

let sortOrder = ["rd", "seeds", "size", "quality", "fl"];
let dragSrc = null;

function renderSortList() {
  const list = document.getElementById("sortList");
  list.innerHTML = "";
  sortOrder.forEach((key) => {
    const c = SORT_CRITERIA.find(x => x.key === key);
    if (!c) return;
    const el = document.createElement("div");
    el.className = "sort-item";
    el.draggable = true;
    el.dataset.key = key;
    el.innerHTML =
      "<span class='sort-handle'>⠿</span>" +
      "<span class='sort-badge " + c.badgeClass + "'>" + c.badge + "</span>" +
      "<div><div class='sort-desc'>" + c.label + "</div><div class='sort-subdesc'>" + c.sub + "</div></div>";

    el.addEventListener("dragstart", e => { dragSrc = el; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
    el.addEventListener("dragend", () => { el.classList.remove("dragging"); document.querySelectorAll(".sort-item").forEach(x => x.classList.remove("drag-over")); });
    el.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; el.classList.add("drag-over"); });
    el.addEventListener("dragleave", () => el.classList.remove("drag-over"));
    el.addEventListener("drop", e => {
      e.preventDefault();
      el.classList.remove("drag-over");
      if (dragSrc === el) return;
      const keys = [...document.querySelectorAll(".sort-item")].map(x => x.dataset.key);
      const fromIdx = keys.indexOf(dragSrc.dataset.key);
      const toIdx = keys.indexOf(el.dataset.key);
      sortOrder.splice(fromIdx, 1);
      sortOrder.splice(toIdx, 0, dragSrc.dataset.key);
      renderSortList();
    });

    list.appendChild(el);
  });
}

renderSortList();

function prepareForm(e) {
  const movieIds = [];
  document.getElementById("catList").querySelectorAll(".cat-row").forEach(row => {
    const v = parseInt(row.querySelector("input[type=number]").value, 10);
    if (!isNaN(v) && v > 0) movieIds.push(v);
  });
  const seriesIds = [];
  document.getElementById("seriesCatList").querySelectorAll(".cat-row").forEach(row => {
    const v = parseInt(row.querySelector("input[type=number]").value, 10);
    if (!isNaN(v) && v > 0) seriesIds.push(v);
  });
  if (movieIds.length === 0 && seriesIds.length === 0) { e.preventDefault(); alert("Add at least one category."); return; }
  document.getElementById("catsInput").value = movieIds.join(",");
  document.getElementById("seriesCatsInput").value = seriesIds.join(",");
  document.getElementById("sortByInput").value = sortOrder.join(",");
}
</script>
</body>
</html>`;
}

function successPage(manifestUrl, stremioUrl, username) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/><title>Linkomanija Ready</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
<style>*{box-sizing:border-box;margin:0;padding:0}
body{background:#0b0d0f;color:#e8e6e1;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
.card{background:#13161a;border:1px solid #1e2328;border-radius:16px;padding:3rem;width:100%;max-width:520px;box-shadow:0 32px 80px rgba(0,0,0,.6)}
h1{font-family:'Bebas Neue',sans-serif;font-size:2rem;margin-bottom:.4rem}
.sub{color:#6b7280;font-size:.875rem;margin-bottom:2rem}
.label{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;margin-bottom:.4rem;margin-top:1.5rem}
.url{background:#0b0d0f;border:1px solid #1e2328;border-radius:8px;padding:.75rem 1rem;font-family:monospace;font-size:.75rem;color:#94a3b8;word-break:break-all;margin-bottom:.75rem}
.btn{display:inline-flex;padding:.75rem 1.5rem;border-radius:8px;border:none;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:.08em;cursor:pointer;text-decoration:none;transition:all .2s;margin-right:.5rem;margin-top:.5rem}
.primary{background:#e8342a;color:#fff}.primary:hover{background:#c42720}
.secondary{background:transparent;color:#6b7280;border:1px solid #1e2328}
.divider{height:1px;background:#1e2328;margin:1.5rem 0}
.note{font-size:.78rem;color:#6b7280;line-height:1.7}
</style></head><body><div class="card">
<div style="font-size:3rem;margin-bottom:1rem">✅</div>
<h1>Ready, ${esc(username)}!</h1>
<p class="sub">Your personal addon URL is generated.</p>
<div class="label">Step 1 — One-click install</div>
<a class="btn primary" href="${esc(stremioUrl)}">⚡ Install in Stremio</a>
<div class="divider"></div>
<div class="label">Step 2 — Or paste manifest URL manually</div>
<div class="url" id="mu">${esc(manifestUrl)}</div>
<button class="btn secondary" onclick="navigator.clipboard.writeText(document.getElementById('mu').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy URL',2000)})">📋 Copy URL</button>
<a class="btn secondary" href="/configure">← Back</a>
<div class="divider"></div>
<p class="note">🔒 Credentials encrypted in URL — never stored.<br/>🎬 Movies + 📺 TV Series · 🟢 Freeleech sorted first<br/>🧲 Returns magnet links — works on Mac, PC and LG TV</p>
</div></body></html>`;
}
