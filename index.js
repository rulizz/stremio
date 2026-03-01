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
    return resp.data && resp.data.meta ? resp.data.meta.name : null;
  } catch (e) { return null; }
}

// ── Credentials ───────────────────────────────────────────────────────────────
function encodeCredentials(username, password, rdKey) {
  return Buffer.from(JSON.stringify({ username, password, rdKey: rdKey || "" })).toString("base64url");
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
// Returns array of { url, filename, filesize } or empty array if not ready
async function rdResolve(rdKey, magnet) {
  try {
    // Step 1: add magnet to RD
    const added = await rdAddMagnet(rdKey, magnet);
    const torrentId = added.id;
    if (!torrentId) throw new Error("No torrent ID from RD");

    // Step 2: select all files
    await rdSelectFiles(rdKey, torrentId);

    // Step 3: poll for ready status (max 8 seconds)
    let info;
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(r => setTimeout(r, 2000));
      info = await rdGetTorrentInfo(rdKey, torrentId);
      console.log("[RD] status=" + info.status + " id=" + torrentId);
      if (info.status === "downloaded" || info.status === "cached") break;
      if (info.status === "error" || info.status === "dead" || info.status === "magnet_error") {
        throw new Error("RD torrent error: " + info.status);
      }
    }

    if (!info || !info.links || info.links.length === 0) {
      console.log("[RD] Not cached yet, returning magnet as fallback");
      return [];
    }

    // Step 4: unrestrict the first video link
    const videoLinks = info.links.slice(0, 3);
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
        console.warn("[RD] Unrestrict failed for link:", e.message);
      }
    }
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
function buildStreams(torrents, title) {
  const streams = [];
  for (const t of torrents) {
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
  const { username, password, rdKey } = req.body;
  if (!username || !password) return res.send(configurePage("Username and password are required."));
  const token = encodeCredentials(username.trim(), password, (rdKey || "").trim());
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
      results = await search(session, query, type);
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

    const streams = buildStreams(withMagnets, title);
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
  return "<!DOCTYPE html><html lang='en'><head>" +
    "<meta charset='UTF-8'/><meta name='viewport' content='width=device-width,initial-scale=1.0'/>" +
    "<title>Linkomanija Stremio Addon</title>" +
    "<link href='https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap' rel='stylesheet'/>" +
    "<style>*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}" +
    ":root{--bg:#0b0d0f;--surface:#13161a;--border:#1e2328;--accent:#e8342a;--accent2:#f5a623;--text:#e8e6e1;--muted:#6b7280}" +
    "body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}" +
    "body::before{content:'';position:fixed;top:-30%;left:-10%;width:60%;height:60%;background:radial-gradient(ellipse,rgba(232,52,42,.12) 0%,transparent 70%);pointer-events:none;z-index:0}" +
    ".card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:3rem;width:100%;max-width:460px;box-shadow:0 32px 80px rgba(0,0,0,.6);animation:fadeUp .5s ease both}" +
    "@keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}" +
    ".logo-row{display:flex;align-items:center;gap:1rem;margin-bottom:2.5rem}.flag{font-size:2rem}" +
    ".brand h1{font-family:'Bebas Neue',sans-serif;font-size:2.2rem;letter-spacing:.06em;line-height:1}" +
    ".brand p{font-size:.78rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-top:2px}" +
    ".divider{height:1px;background:var(--border);margin:0 0 2rem}" +
    "label{display:block;font-size:.75rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem}" +
    "input{width:100%;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem;color:var(--text);font-family:'DM Sans',sans-serif;font-size:.95rem;outline:none;transition:border-color .2s;margin-bottom:1.25rem}" +
    "input:focus{border-color:var(--accent)}input::placeholder{color:#3a3f47}" +
    "button[type=submit]{width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:.9rem;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:.1em;cursor:pointer;margin-top:.5rem}" +
    "button[type=submit]:hover{background:#c42720}" +
    ".error{background:rgba(232,52,42,.1);border:1px solid rgba(232,52,42,.3);border-radius:8px;padding:.75rem 1rem;font-size:.875rem;color:#f87171;margin-bottom:1.5rem}" +
    ".note{font-size:.78rem;color:var(--muted);text-align:center;margin-top:1.5rem;line-height:1.6}" +
    ".note a{color:var(--accent2);text-decoration:none}" +
    ".badge{display:inline-flex;background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.2);color:var(--accent2);font-size:.7rem;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:99px;margin-bottom:1.5rem}" +
    "</style></head><body>" +
    "<div class='card'>" +
    "<div class='logo-row'><span class='flag'>🇱🇹</span><div class='brand'><h1>Linkomanija</h1><p>Stremio Addon</p></div></div>" +
    "<span class='badge'>🔒 Credentials stay in your Stremio URL</span>" +
    "<div class='divider'></div>" +
    (error ? "<div class='error'>" + error + "</div>" : "") +
    "<form method='POST' action='/configure'>" +
    "<label>Username</label><input type='text' name='username' placeholder='your_username' autocomplete='username' required/>" +
    "<label>Password</label><input type='password' name='password' placeholder='••••••••' autocomplete='current-password' required/>" +
    "<label>Real-Debrid API Key <span style=\'font-weight:300;text-transform:none\'>— optional, for instant streaming</span></label>" +
    "<input type='text' name='rdKey' placeholder='your RD API key (real-debrid.com/apitoken)'/>" +
    "<button type='submit'>Generate My Addon URL →</button>" +
    "</form>" +
    "<p class='note'>Requires <a href='https://www.linkomanija.net' target='_blank'>Linkomanija.net</a> account.<br/>Credentials encoded in URL — never stored.</p>" +
    "</div></body></html>";
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
