const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const { login, search, debugSearch, invalidateSession } = require("./linkomanija");

const PORT = process.env.PORT || 3000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ── IMDB → title ──────────────────────────────────────────────────────────────
async function getImdbTitle(imdbId, type) {
  try {
    const resp = await axios.get(
      "https://cinemeta-live.strem.io/meta/" + type + "/" + imdbId + ".json",
      { timeout: 8000 }
    );
    const meta = resp.data && resp.data.meta;
    if (!meta) return { title: null, year: null };
    return { title: meta.name || null, year: meta.year || null };
  } catch (e) { return { title: null, year: null }; }
}

// ── Credentials ───────────────────────────────────────────────────────────────
function encodeCredentials(username, password, rdKey, cats, sortBy) {
  return Buffer.from(JSON.stringify({
    username,
    password,
    rdKey: rdKey || "",
    cats: cats || [61, 53],       // category IDs to search
    sortBy: sortBy || ["rd","seeds","size","quality","fl"],
  })).toString("base64url");
}
function decodeCredentials(token) {
  try { return JSON.parse(Buffer.from(token, "base64url").toString("utf8")); }
  catch (e) { return null; }
}

// ── Real-Debrid API ───────────────────────────────────────────────────────────
const RD_API = "https://api.real-debrid.com/rest/1.0";

async function rdAddMagnet(rdKey, magnet) {
  const resp = await axios.post(
    RD_API + "/torrents/addMagnet",
    "magnet=" + encodeURIComponent(magnet),
    { headers: { Authorization: "Bearer " + rdKey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 15000 }
  );
  return resp.data; // { id, uri }
}

async function rdSelectFiles(rdKey, torrentId) {
  // Select all files
  await axios.post(
    RD_API + "/torrents/selectFiles/" + torrentId,
    "files=all",
    { headers: { Authorization: "Bearer " + rdKey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
}

async function rdGetTorrentInfo(rdKey, torrentId) {
  const resp = await axios.get(
    RD_API + "/torrents/info/" + torrentId,
    { headers: { Authorization: "Bearer " + rdKey }, timeout: 10000 }
  );
  return resp.data; // { status, links, filename, ... }
}

async function rdUnrestrictLink(rdKey, link) {
  const resp = await axios.post(
    RD_API + "/unrestrict/link",
    "link=" + encodeURIComponent(link),
    { headers: { Authorization: "Bearer " + rdKey, "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
  );
  return resp.data; // { download, filename, filesize, ... }
}

// Full flow: magnet → RD → direct stream URL
// Returns array of { url, filename, filesize } or empty array if not ready yet.
//
// RD status flow:
//   magnet_conversion → waiting → downloading → downloaded ✅
//   or: cached ✅ (already on RD servers — instant)
async function rdResolve(rdKey, magnet) {
  try {
    // Step 1: add magnet to RD
    const added = await rdAddMagnet(rdKey, magnet);
    const torrentId = added.id;
    if (!torrentId) throw new Error("No torrent ID from RD");
    console.log("[RD] Added torrent id=" + torrentId);

    // Step 2: select all files (required before RD starts processing)
    await rdSelectFiles(rdKey, torrentId);

    // Step 3: poll for ready status
    // RD can take 30-90 seconds for magnet conversion on first add.
    // We poll for up to 25 seconds — if not ready we return [] and the
    // magnet fallback is shown to the user. They can click again once RD
    // has had time to process it (it stays in their RD account).
    let info;
    const POLL_INTERVAL = 2500; // ms between polls
    const MAX_POLLS = 10;       // 10 × 2.5s = 25 seconds max wait
    for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL));
      info = await rdGetTorrentInfo(rdKey, torrentId);
      console.log("[RD] poll " + (attempt+1) + "/" + MAX_POLLS + " status=" + info.status);

      if (info.status === "downloaded") break;

      // "cached" means RD already has this torrent — links are ready immediately
      if (info.status === "cached") break;

      // Fatal errors — no point retrying
      if (["error", "dead", "magnet_error", "virus", "compressing", "uploading"].includes(info.status)) {
        console.warn("[RD] terminal status: " + info.status);
        return [];
      }
      // magnet_conversion, waiting, downloading → keep polling
    }

    if (!info || !info.links || info.links.length === 0) {
      console.log("[RD] Still processing after polling — torrent is queued in RD, magnet shown as fallback");
      return [];
    }

    // Step 4: unrestrict links to get direct HTTPS video URLs
    // Filter to likely video files by checking for video extensions
    const videoLinks = info.links.slice(0, 5);
    const results = [];
    for (const link of videoLinks) {
      try {
        const unrestricted = await rdUnrestrictLink(rdKey, link);
        if (unrestricted.download) {
          results.push({
            url: unrestricted.download,
            filename: unrestricted.filename || info.filename || "video",
            filesize: unrestricted.filesize || 0,
          });
        }
      } catch (e) {
        console.warn("[RD] Unrestrict failed:", e.message);
      }
    }

    console.log("[RD] Resolved " + results.length + " direct links for id=" + torrentId);
    return results;
  } catch (err) {
    console.error("[RD] resolve error:", err.message);
    return [];
  }
}

// ── Parse torrent buffer → info hash → magnet URI ────────────────────────────
// We do a minimal bencode parse to extract just the info hash.
// This avoids needing a heavy parse-torrent library.
function extractInfoHash(torrentBuffer) {
  // Find "4:info" in the buffer, then hash everything from there to the end dict
  const buf = Buffer.isBuffer(torrentBuffer) ? torrentBuffer : Buffer.from(torrentBuffer);
  const marker = Buffer.from("4:info");
  const infoStart = buf.indexOf(marker);
  if (infoStart === -1) throw new Error("Could not find info dict in torrent");

  // The info dict starts right after "4:info"
  const infoDictStart = infoStart + marker.length;

  // Find the matching end of the info dict by counting bencode nesting
  let depth = 0;
  let i = infoDictStart;
  while (i < buf.length) {
    const ch = buf[i];
    if (ch === 100 || ch === 108) { depth++; i++; } // 'd' or 'l'
    else if (ch === 101) { depth--; i++; if (depth === 0) break; } // 'e'
    else if (ch >= 48 && ch <= 57) { // digit — string length prefix
      let numEnd = i;
      while (buf[numEnd] !== 58) numEnd++; // find ':'
      const strLen = parseInt(buf.slice(i, numEnd).toString(), 10);
      i = numEnd + 1 + strLen;
    } else if (ch === 105) { // 'i' — integer
      let end = buf.indexOf(101, i + 1); // find 'e'
      i = end + 1;
    } else { i++; }
  }

  const infoDict = buf.slice(infoDictStart, i);
  const hash = crypto.createHash("sha1").update(infoDict).digest("hex");
  return hash;
}

function buildMagnet(infoHash, name) {
  const trackers = [
    "udp://tracker.opentrackr.org:1337/announce",
    "udp://open.tracker.cl:1337/announce",
    "udp://tracker.openbittorrent.com:6969/announce",
    "http://tracker.linkomanija.net:2710/announce",
  ].map(t => "&tr=" + encodeURIComponent(t)).join("");
  return "magnet:?xt=urn:btih:" + infoHash +
    "&dn=" + encodeURIComponent(name || infoHash) +
    trackers;
}

// ── Build stream list ─────────────────────────────────────────────────────────
// Convert "2.45 GB" / "700 MB" → bytes for numeric sort
function parseSize(sizeStr) {
  if (!sizeStr) return 0;
  const m = sizeStr.replace(/,/g, "").match(/([\d.]+)\s*(TB|GB|MB|KB)/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = m[2].toUpperCase();
  if (unit === "TB") return n * 1e12;
  if (unit === "GB") return n * 1e9;
  if (unit === "MB") return n * 1e6;
  if (unit === "KB") return n * 1e3;
  return n;
}

const QUALITY_SCORE = s => {
  if (!s) return 0;
  const u = s.toUpperCase();
  if (u.includes("4K") || u.includes("2160")) return 4;
  if (u.includes("1080")) return 3;
  if (u.includes("720")) return 2;
  return 1;
};

function buildStreams(torrents, title, sortBy) {
  const order = Array.isArray(sortBy) ? sortBy : ["rd", "seeds", "size", "quality", "fl"];

  // Expand each torrent into entries: RD streams + magnet fallback
  // We attach sort keys to each entry then sort the flat list
  const entries = [];
  for (const t of torrents) {
    if (!t.magnet) continue;
    const base = {
      _seeds: t.seeders || 0,
      _size: parseSize(t.size),
      _quality: QUALITY_SCORE(t.quality),
      _fl: t.freeleech ? 1 : 0,
      name: "LT Linkomanija\n" + t.quality + (t.freeleech ? " FL" : ""),
      description: t.name + "\n" + (t.size || "?") + " | Seeds: " + t.seeders + " | Leech: " + t.leechers,
      behaviorHints: { bingeGroup: "lm-" + title },
    };

    if (t.rdStreams && t.rdStreams.length > 0) {
      for (const rd of t.rdStreams) {
        entries.push(Object.assign({}, base, {
          _rd: 1,
          name: base.name + " RD",
          description: base.description + "\n⚡ Real-Debrid — " + rd.filename,
          url: rd.url,
        }));
      }
    }

    entries.push(Object.assign({}, base, { _rd: 0, url: t.magnet }));
  }

  // Sort by user-defined priority order
  entries.sort((a, b) => {
    for (const key of order) {
      let diff = 0;
      if (key === "rd")      diff = b._rd      - a._rd;
      if (key === "seeds")   diff = b._seeds   - a._seeds;
      if (key === "size")    diff = b._size    - a._size;
      if (key === "quality") diff = b._quality - a._quality;
      if (key === "fl")      diff = b._fl      - a._fl;
      if (diff !== 0) return diff;
    }
    return 0;
  });

  // Strip internal sort keys before returning
  return entries.map(({ _rd, _seeds, _size, _quality, _fl, ...stream }) => stream);


  const streams = [];
  for (const t of sorted) {
    if (!t.magnet) continue;
    const label = "LT Linkomanija\n" + t.quality + (t.freeleech ? " FL" : "");
    const desc = t.name + "\n" + (t.size || "?") + " | Seeds: " + t.seeders + " | Leech: " + t.leechers;

    // If RD resolved direct links, add those first (instant play)
    if (t.rdStreams && t.rdStreams.length > 0) {
      for (const rd of t.rdStreams) {
        streams.push({
          name: label + " RD",
          description: desc + "\n⚡ Real-Debrid — " + rd.filename,
          url: rd.url,
          behaviorHints: { bingeGroup: "lm-" + title },
        });
      }
    }

    // Always also add the magnet as fallback
    streams.push({
      name: label,
      description: desc,
      url: t.magnet,
      behaviorHints: { bingeGroup: "lm-" + title },
    });
  }
  return streams;
}

// ── Resolve magnets for a list of torrents ────────────────────────────────────
async function resolveMagnets(session, torrents) {
  // Download all .torrent files in parallel (max 5 at a time to avoid hammering LM)
  const BATCH = 5;
  const results = [...torrents];

  for (let i = 0; i < results.length; i += BATCH) {
    const batch = results.slice(i, i + BATCH);
    await Promise.all(batch.map(async t => {
      try {
        let dlUrl = "https://www.linkomanija.net/download.php?id=" + t.id;
        if (session.passkey) dlUrl += "&passkey=" + session.passkey;

        const resp = await session.client.get(dlUrl, {
          responseType: "arraybuffer",
          maxRedirects: 10,
          timeout: 15000,
          headers: {
            Accept: "application/x-bittorrent, application/octet-stream, */*",
            Referer: "https://www.linkomanija.net/browse.php",
          },
        });

        const data = Buffer.from(resp.data);
        const ct = resp.headers["content-type"] || "";
        if (ct.includes("text/html") || data.length < 100) {
          console.warn("[MAGNET] id=" + t.id + " got HTML — skipping");
          return;
        }

        const infoHash = extractInfoHash(data);
        t.magnet = buildMagnet(infoHash, t.name);
        console.log("[MAGNET] id=" + t.id + " hash=" + infoHash.substring(0, 8) + "...");
      } catch (err) {
        console.warn("[MAGNET] id=" + t.id + " failed: " + err.message);
      }
    }));
  }

  return results;
}

// ── Express ───────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => res.send(configurePage()));
app.post("/configure", (req, res) => {
  const { username, password, rdKey, cats, sortBy } = req.body;
  if (!username || !password) return res.send(configurePage("Username and password are required."));
  // cats comes as comma-separated string "61,53" from the form
  const catList = (cats || "61,53").split(",").map(c => parseInt(c.trim(), 10)).filter(n => !isNaN(n) && n > 0);
  const sortList = (sortBy || "rd,seeds,size,quality,fl").split(",").map(s => s.trim()).filter(Boolean);
  const token = encodeCredentials(username.trim(), password, (rdKey || "").trim(), catList, sortList);
  const manifestUrl = ADDON_URL + "/" + token + "/manifest.json";
  const host = new URL(ADDON_URL).host;
  const stremioUrl = "stremio://" + host + "/" + token + "/manifest.json";
  res.send(successPage(manifestUrl, stremioUrl, username.trim()));
});

// ── Manifest ──────────────────────────────────────────────────────────────────
app.get("/:token/manifest.json", (req, res) => {
  const creds = decodeCredentials(req.params.token);
  if (!creds) return res.status(400).json({ error: "Invalid token" });
  res.json({
    id: "community.linkomanija." + creds.username,
    version: "1.0.3",
    name: "LT Linkomanija (" + creds.username + ")",
    description: "Streams from Linkomanija.net private tracker.",
    logo: "https://www.linkomanija.net/favicon.ico",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
    configureUrl: ADDON_URL + "/configure",
  });
});

// ── Stream handler ────────────────────────────────────────────────────────────
app.get("/:token/stream/:type/:id.json", async (req, res) => {
  const { token, type, id } = req.params;
  const creds = decodeCredentials(token);
  if (!creds) return res.json({ streams: [] });

  const imdbId  = id.split(":")[0];
  const season  = id.includes(":") ? id.split(":")[1] : null;
  const episode = id.includes(":") ? id.split(":")[2] : null;

  console.log("[STREAM] " + type + " | " + id + " | " + creds.username);

  try {
    const session = await login(creds.username, creds.password);
    const title = await getImdbTitle(imdbId, type);
    if (!title) { console.warn("[IMDB] No title for " + imdbId); return res.json({ streams: [] }); }
    console.log("[IMDB] " + title);

    const cats = creds.cats || [61, 53];
    const sortBy = Array.isArray(creds.sortBy) ? creds.sortBy : (creds.sortBy || "seeds").split(",");

    const queries = [];
    if (type === "series" && season && episode) {
      const s = String(season).padStart(2, "0");
      const e = String(episode).padStart(2, "0");
      queries.push(title + " S" + s + "E" + e);
      queries.push(title + " S" + s);
    }
    queries.push(title);

    let results = [];
    for (const query of queries) {
      results = await search(session, query, type, cats);
      if (results.length > 0) { console.log("[STREAM] " + results.length + " results for: " + query); break; }
    }

    // Resolve magnet links for top results
    const topResults = results.slice(0, 10);
    const withMagnets = await resolveMagnets(session, topResults);

    // If user has RD key, resolve magnets to direct streams in parallel
    if (creds.rdKey) {
      console.log("[RD] Resolving " + withMagnets.filter(t => t.magnet).length + " magnets via Real-Debrid");
      await Promise.all(
        withMagnets
          .filter(t => t.magnet)
          .slice(0, 5) // limit RD calls to top 5
          .map(async t => {
            t.rdStreams = await rdResolve(creds.rdKey, t.magnet);
            if (t.rdStreams.length > 0) console.log("[RD] " + t.id + " -> " + t.rdStreams.length + " direct streams");
          })
      );
    }

    const streams = buildStreams(withMagnets, title, sortBy);
    console.log("[STREAM] Returning " + streams.length + " streams");
    res.json({ streams });
  } catch (err) {
    console.error("[STREAM ERROR]", err.message);
    if (err.message && err.message.toLowerCase().includes("login")) invalidateSession(creds.username);
    res.json({ streams: [] });
  }
});

// ── Magnet endpoint ───────────────────────────────────────────────────────────
// Stremio calls this URL. We:
//   1. Download the .torrent file from LM using our authenticated session
//   2. Extract the info hash using minimal bencode parsing
//   3. Redirect Stremio to a magnet:// URI
// Stremio on Mac/PC/TV handles magnet URIs natively via its built-in torrent engine.
app.get("/magnet/:token/:torrentId/:name?", async (req, res) => {
  const { token, torrentId } = req.params;
  const name = req.params.name ? decodeURIComponent(req.params.name) : torrentId;
  const creds = decodeCredentials(token);
  if (!creds) return res.status(401).send("Invalid token");

  console.log("[MAGNET] id=" + torrentId + " name=" + name);

  try {
    const session = await login(creds.username, creds.password);

    let dlUrl = "https://www.linkomanija.net/download.php?id=" + torrentId;
    if (session.passkey) dlUrl += "&passkey=" + session.passkey;

    const resp = await session.client.get(dlUrl, {
      responseType: "arraybuffer",
      maxRedirects: 10,
      headers: {
        Accept: "application/x-bittorrent, application/octet-stream, */*",
        Referer: "https://www.linkomanija.net/browse.php",
      },
    });

    const data = Buffer.from(resp.data);
    const contentType = resp.headers["content-type"] || "";

    if (contentType.includes("text/html") || data.length < 100) {
      console.error("[MAGNET] Got HTML — session expired");
      invalidateSession(creds.username);
      return res.status(401).send("Session expired — try again");
    }

    // Extract info hash and build magnet URI
    const infoHash = extractInfoHash(data);
    const magnet = buildMagnet(infoHash, name);

    console.log("[MAGNET] infoHash=" + infoHash + " -> redirecting to magnet");

    // Redirect to magnet URI — Stremio follows this redirect and opens the magnet
    res.redirect(302, magnet);
  } catch (err) {
    console.error("[MAGNET ERROR]", err.message);
    res.status(500).send("Failed: " + err.message);
  }
});

// ── Proxy (kept for direct .torrent downloads) ────────────────────────────────
app.get("/torrent-proxy/:token/:torrentId", async (req, res) => {
  const { token, torrentId } = req.params;
  const creds = decodeCredentials(token);
  if (!creds) return res.status(401).send("Invalid token");

  try {
    const session = await login(creds.username, creds.password);
    let dlUrl = "https://www.linkomanija.net/download.php?id=" + torrentId;
    if (session.passkey) dlUrl += "&passkey=" + session.passkey;

    const resp = await session.client.get(dlUrl, {
      responseType: "arraybuffer", maxRedirects: 10,
      headers: { Accept: "application/x-bittorrent, */*", Referer: "https://www.linkomanija.net/browse.php" },
    });

    const data = Buffer.from(resp.data);
    res.setHeader("Content-Type", "application/x-bittorrent");
    res.setHeader("Content-Disposition", "attachment; filename=\"" + torrentId + ".torrent\"");
    res.setHeader("Content-Length", data.length);
    res.send(data);
  } catch (err) {
    res.status(500).send("Error: " + err.message);
  }
});

// ── Proxy test ────────────────────────────────────────────────────────────────
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
    const contentType = resp.headers["content-type"] || "unknown";
    const first30 = data.slice(0, 30).toString("latin1").replace(/[^\x20-\x7E]/g, ".");
    const isHtml = contentType.includes("html") || data.toString("utf8", 0, 100).includes("<html");
    const isValid = data.length > 200 && !isHtml;

    let infoHash = "";
    if (isValid) {
      try { infoHash = extractInfoHash(data); } catch (e) { infoHash = "parse error: " + e.message; }
    }

    const magnetUrl = isValid && infoHash.length === 40
      ? "/magnet/" + token + "/" + torrentId + "/test"
      : "";

    res.send("<!DOCTYPE html><html><head><style>" +
      "body{font-family:monospace;background:#111;color:#eee;padding:20px}" +
      ".good{color:#22c55e}.bad{color:#f87171}" +
      "table{border-collapse:collapse;margin:1rem 0}td{padding:6px 12px;border:1px solid #333}" +
      "a{color:#60a5fa}" +
      "</style></head><body>" +
      "<h2 style='color:#f5a623'>Proxy Test id=" + torrentId + "</h2>" +
      "<table>" +
      "<tr><td>URL</td><td>" + dlUrl + "</td></tr>" +
      "<tr><td>Content-Type</td><td>" + contentType + "</td></tr>" +
      "<tr><td>Size</td><td>" + data.length + " bytes</td></tr>" +
      "<tr><td>Passkey</td><td>" + (session.passkey ? "YES " + session.passkey.substring(0, 8) + "..." : "NOT FOUND") + "</td></tr>" +
      "<tr><td>First 30 bytes</td><td><code>" + first30 + "</code></td></tr>" +
      "<tr><td>Info Hash</td><td class='" + (infoHash.length === 40 ? "good" : "bad") + "'>" + (infoHash || "n/a") + "</td></tr>" +
      "<tr><td>Verdict</td><td class='" + (isValid ? "good" : "bad") + "'>" + (isValid ? "VALID TORRENT" : "HTML OR EMPTY") + "</td></tr>" +
      "</table>" +
      (isValid && infoHash.length === 40
        ? "<p class='good'>Info hash extracted! <a href='" + magnetUrl + "'>Test magnet redirect</a></p>"
        : "<p class='bad'>Could not extract info hash</p>") +
      (isHtml ? "<pre>" + data.toString("utf8").substring(0, 2000).replace(/</g, "&lt;") + "</pre>" : "") +
      "</body></html>");
  } catch (err) {
    res.send("<b style='color:red'>Error: " + err.message + "</b><pre>" + err.stack + "</pre>");
  }
});

// ── Debug ─────────────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const { token, query, type } = req.query;
  if (!token || !query) {
    return res.send("<!DOCTYPE html><html><head><style>" +
      "body{font-family:monospace;background:#111;color:#eee;padding:20px}" +
      "input,select{background:#222;color:#eee;border:1px solid #444;padding:8px;margin:8px 0;display:block;width:400px}" +
      "button{background:#e8342a;color:#fff;border:none;padding:10px 20px;cursor:pointer;margin-top:8px}" +
      "</style></head><body>" +
      "<h2 style='color:#f5a623'>LM Debug</h2><form>" +
      "<label>Token</label><input name='token' value='" + (token || "") + "'/>" +
      "<label>Query</label><input name='query' value='" + (query || "") + "'/>" +
      "<label>Type</label><select name='type'>" +
      "<option value='movie'" + (type === "movie" ? " selected" : "") + ">movie</option>" +
      "<option value='series'" + (type === "series" ? " selected" : "") + ">series</option>" +
      "</select><button type='submit'>Run Debug</button></form></body></html>");
  }

  const creds = decodeCredentials(token);
  if (!creds) return res.send("<b style='color:red'>Invalid token</b>");

  try {
    const session = await login(creds.username, creds.password);
    const { html, url } = await debugSearch(session, query);
    const cheerio = require("cheerio");
    const $ = cheerio.load(html);
    const rows = $("tr.torrenttable");
    const dlLinks = $('a[href*="download.php"]');
    let firstRowHtml = rows.length > 0 ? $.html(rows.first()) : "";
    let tdInfo = [];
    if (rows.length > 0) {
      rows.first().find("td").each((i, td) => {
        tdInfo.push("td[" + i + "] class=\"" + ($(td).attr("class") || "") + "\" = \"" + $(td).text().trim().substring(0, 50) + "\"");
      });
    }

    res.send("<!DOCTYPE html><html><head><style>" +
      "body{font-family:monospace;background:#111;color:#eee;padding:20px}" +
      "h2{color:#f5a623}h3{color:#22c55e;margin-top:1.5rem}" +
      "pre{background:#1a1a1a;border:1px solid #333;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}" +
      ".good{color:#22c55e}.bad{color:#f87171}a{color:#60a5fa}" +
      "</style></head><body>" +
      "<h2>Debug: " + query + "</h2>" +
      "<p><a href='" + url + "'>" + url + "</a> (" + html.length + " bytes)</p>" +
      "<h3>Rows</h3>" +
      "<p class='" + (rows.length > 0 ? "good" : "bad") + "'>tr.torrenttable: " + rows.length + "</p>" +
      "<p>download.php links: " + dlLinks.length + "</p>" +
      "<h3>TD breakdown (first row)</h3>" +
      "<pre>" + tdInfo.join("\n") + "</pre>" +
      "<h3>First row HTML</h3>" +
      "<pre>" + firstRowHtml.replace(/</g, "&lt;").substring(0, 4000) + "</pre>" +
      "</body></html>");
  } catch (err) {
    res.send("<b style='color:red'>" + err.message + "</b><pre>" + err.stack + "</pre>");
  }
});

app.get("/health", (req, res) => res.json({ status: "ok", addonUrl: ADDON_URL }));

app.listen(PORT, () => {
  console.log("Linkomanija addon on port " + PORT);
  console.log("Configure: " + ADDON_URL + "/configure");
});

// ── HTML pages ────────────────────────────────────────────────────────────────
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

    /* Header */
    .header{display:flex;align-items:center;gap:1rem;margin-bottom:2rem}
    .header h1{font-family:"Bebas Neue",sans-serif;font-size:2.4rem;letter-spacing:.06em;line-height:1}
    .header p{font-size:.75rem;color:var(--muted);letter-spacing:.1em;text-transform:uppercase;margin-top:3px}

    /* Section cards */
    .section{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.5rem;margin-bottom:1rem}
    .section-title{font-size:.65rem;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-bottom:1.25rem;display:flex;align-items:center;gap:.5rem}
    .section-title::after{content:"";flex:1;height:1px;background:var(--border)}

    /* Form fields */
    .field{margin-bottom:1rem}
    .field:last-child{margin-bottom:0}
    .field label{display:block;font-size:.72rem;font-weight:500;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);margin-bottom:.45rem}
    .field label span{text-transform:none;font-weight:300;letter-spacing:0;color:#4b5563}
    input[type=text],input[type=password]{width:100%;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.8rem 1rem;color:var(--text);font-family:"DM Sans",sans-serif;font-size:.9rem;outline:none;transition:border-color .2s,box-shadow .2s}
    input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,52,42,.12)}
    input::placeholder{color:#2e333a}

    /* Category builder */
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

    /* Sort order drag list */
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

    /* Submit */
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

  ${error ? `<div class="error-box">⚠ ${error}</div>` : ""}

  <form method="POST" action="/configure" onsubmit="prepareForm(event)">

    <!-- ── Account ── -->
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

    <!-- ── Real-Debrid ── -->
    <div class="section">
      <div class="section-title">Real-Debrid <span style="text-transform:none;font-weight:300;letter-spacing:0;color:#3d4450;font-size:.6rem;margin-left:.25rem">— optional</span></div>
      <div class="field">
        <label>API Key <span>— enables instant streaming via Real-Debrid</span></label>
        <input type="text" name="rdKey" placeholder="Get yours at real-debrid.com/apitoken"/>
      </div>
    </div>

    <!-- ── Categories ── -->
    <div class="section">
      <div class="section-title">Categories to Search</div>
      <div class="cat-list" id="catList"></div>
      <button type="button" class="add-cat" onclick="addCat()">+ Add category</button>
      <input type="hidden" name="cats" id="catsInput"/>
      <p class="cat-hint">
        Find category IDs by browsing <a href="https://www.linkomanija.net/browse.php" target="_blank">linkomanija.net/browse.php</a>
        — the number after <code>cat=</code> in the URL is the ID.<br/>
        Example: <code>browse.php?cat=61</code> → ID is <strong>61</strong>
      </p>
    </div>

    <!-- ── Stream Sort Order ── -->
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
    Credentials are encoded in your URL only — never stored on this server.<br/>
    <a href="https://www.linkomanija.net" target="_blank">linkomanija.net</a> account required.
  </p>
</div>

<script>
// ── Default categories ──────────────────────────────────────────────────────
const DEFAULT_CATS = [
  { id: 61, label: "Movies LT" },
  { id: 53, label: "Movies EN" },
];

function addCat(id, label) {
  const list = document.getElementById("catList");
  const row = document.createElement("div");
  row.className = "cat-row";
  row.innerHTML =
    "<input type='number' placeholder='ID' value='" + (id || "") + "' min='1' max='999'/>" +
    "<input type='text' placeholder='Label (optional)' value='" + (label || "") + "'/>" +
    "<button type='button' class='del' onclick='this.parentElement.remove()' title='Remove'>×</button>";
  list.appendChild(row);
}

DEFAULT_CATS.forEach(c => addCat(c.id, c.label));

// ── Sort criteria ───────────────────────────────────────────────────────────
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
  sortOrder.forEach((key, i) => {
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

// ── Form submission ─────────────────────────────────────────────────────────
function prepareForm(e) {
  // Collect category IDs
  const rows = document.querySelectorAll(".cat-row");
  const ids = [];
  rows.forEach(row => {
    const idVal = parseInt(row.querySelector("input[type=number]").value, 10);
    if (!isNaN(idVal) && idVal > 0) ids.push(idVal);
  });
  if (ids.length === 0) { e.preventDefault(); alert("Add at least one category."); return; }
  document.getElementById("catsInput").value = ids.join(",");
  document.getElementById("sortByInput").value = sortOrder.join(",");
}
</script>
</body>
</html>`;
}


function successPage(manifestUrl, stremioUrl, username) {
  return "<!DOCTYPE html><html><head><meta charset='UTF-8'/><title>Linkomanija Ready</title>" +
    "<link href='https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap' rel='stylesheet'/>" +
    "<style>*{box-sizing:border-box;margin:0;padding:0}" +
    "body{background:#0b0d0f;color:#e8e6e1;font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}" +
    ".card{background:#13161a;border:1px solid #1e2328;border-radius:16px;padding:3rem;width:100%;max-width:520px;box-shadow:0 32px 80px rgba(0,0,0,.6)}" +
    "h1{font-family:'Bebas Neue',sans-serif;font-size:2rem;margin-bottom:.4rem}" +
    ".sub{color:#6b7280;font-size:.875rem;margin-bottom:2rem}" +
    ".label{font-size:.7rem;text-transform:uppercase;letter-spacing:.1em;color:#6b7280;margin-bottom:.4rem;margin-top:1.5rem}" +
    ".url{background:#0b0d0f;border:1px solid #1e2328;border-radius:8px;padding:.75rem 1rem;font-family:monospace;font-size:.75rem;color:#94a3b8;word-break:break-all;margin-bottom:.75rem}" +
    ".btn{display:inline-flex;padding:.75rem 1.5rem;border-radius:8px;border:none;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:.08em;cursor:pointer;text-decoration:none;transition:all .2s;margin-right:.5rem;margin-top:.5rem}" +
    ".primary{background:#e8342a;color:#fff}.primary:hover{background:#c42720}" +
    ".secondary{background:transparent;color:#6b7280;border:1px solid #1e2328}" +
    ".divider{height:1px;background:#1e2328;margin:1.5rem 0}" +
    ".note{font-size:.78rem;color:#6b7280;line-height:1.7}" +
    "</style></head><body><div class='card'>" +
    "<div style='font-size:3rem;margin-bottom:1rem'>✅</div>" +
    "<h1>Ready, " + username + "!</h1>" +
    "<p class='sub'>Your personal addon URL is generated.</p>" +
    "<div class='label'>Step 1 — One-click install</div>" +
    "<a class='btn primary' href='" + stremioUrl + "'>⚡ Install in Stremio</a>" +
    "<div class='divider'></div>" +
    "<div class='label'>Step 2 — Or paste manifest URL manually</div>" +
    "<div class='url' id='mu'>" + manifestUrl + "</div>" +
    "<button class='btn secondary' onclick='navigator.clipboard.writeText(document.getElementById(\"mu\").textContent).then(()=>{this.textContent=\"Copied!\";setTimeout(()=>this.textContent=\"Copy URL\",2000)})'>📋 Copy URL</button>" +
    "<a class='btn secondary' href='/configure'>← Back</a>" +
    "<div class='divider'></div>" +
    "<p class='note'>🔒 Credentials encoded in URL — never stored.<br/>🎬 Movies + 📺 TV Series · 🟢 Freeleech sorted first<br/>🧲 Returns magnet links — works on Mac, PC and LG TV</p>" +
    "</div></body></html>";
}
