/**
 * index.js — Linkomanija Stremio Addon
 */

const express = require("express");
const axios = require("axios");
const { login, search, debugSearch, invalidateSession } = require("./linkomanija");

const PORT = process.env.PORT || 3000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ── IMDB → title ──────────────────────────────────────────────────────────────
async function getImdbTitle(imdbId, type) {
  try {
    const resp = await axios.get(
      `https://cinemeta-live.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 8000 }
    );
    return resp.data?.meta?.name || null;
  } catch {
    return null;
  }
}

// ── Credentials ───────────────────────────────────────────────────────────────
function encodeCredentials(username, password) {
  return Buffer.from(JSON.stringify({ username, password })).toString("base64url");
}
function decodeCredentials(token) {
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch { return null; }
}

// ── Build stream list ─────────────────────────────────────────────────────────
// Instead of returning the direct LM download URL (which needs a session cookie),
// we return a URL pointing back to OUR server's /torrent-proxy endpoint.
// Our server fetches the .torrent file with the session cookie and pipes it to Stremio.
function buildStreams(torrents, title, token) {
  return torrents
    .sort((a, b) => {
      if (a.freeleech !== b.freeleech) return b.freeleech ? 1 : -1;
      const qScore = q => q.includes("4K") ? 4 : q.includes("1080") ? 3 : q.includes("720") ? 2 : 1;
      const qd = qScore(b.quality) - qScore(a.quality);
      if (qd !== 0) return qd;
      return b.seeders - a.seeders;
    })
    .map(t => {
      // Proxy URL — our server downloads the .torrent on behalf of Stremio
      const proxyUrl = `${ADDON_URL}/torrent-proxy/${token}/${t.id}`;
      const seeds = t.seeders > 0 ? `👤 ${t.seeders}` : "💀 0 seeds";
      const fl = t.freeleech ? " 🟢 FL" : "";
      return {
        name: `🇱🇹 Linkomanija\n${t.quality}${fl}`,
        description: `${t.name}\n💾 ${t.size || "?"} | ${seeds} | ⬇ ${t.leechers}`,
        url: proxyUrl,
        behaviorHints: { notWebReady: true, bingeGroup: `lm-${title}` },
      };
    })
    .slice(0, 20);
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

// ── Configure page ────────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => res.send(configurePage()));
app.post("/configure", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send(configurePage("Username and password are required."));
  const token = encodeCredentials(username.trim(), password);
  const manifestUrl = `${ADDON_URL}/${token}/manifest.json`;
  const host = new URL(ADDON_URL).host;
  const stremioUrl = `stremio://${host}/${token}/manifest.json`;
  res.send(successPage(manifestUrl, stremioUrl, username.trim()));
});

// ── Manifest ──────────────────────────────────────────────────────────────────
app.get("/:token/manifest.json", (req, res) => {
  const creds = decodeCredentials(req.params.token);
  if (!creds) return res.status(400).json({ error: "Invalid token" });
  res.json({
    id: `community.linkomanija.${creds.username}`,
    version: "1.0.1",
    name: `🇱🇹 Linkomanija (${creds.username})`,
    description: "Streams from Linkomanija.net — Lithuanian private torrent tracker.",
    logo: "https://www.linkomanija.net/favicon.ico",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: { configurable: true, configurationRequired: false },
    configureUrl: `${ADDON_URL}/configure`,
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

  console.log(`[STREAM] ${type} | ${id} | user=${creds.username}`);

  try {
    const session = await login(creds.username, creds.password);
    const title = await getImdbTitle(imdbId, type);
    if (!title) { console.warn("[IMDB] Could not resolve:", imdbId); return res.json({ streams: [] }); }
    console.log(`[IMDB] Resolved: "${title}"`);

    const queries = [];
    if (type === "series" && season && episode) {
      const s = String(season).padStart(2, "0");
      const e = String(episode).padStart(2, "0");
      queries.push(`${title} S${s}E${e}`);
      queries.push(`${title} S${s}`);
    }
    queries.push(title);

    let results = [];
    for (const query of queries) {
      results = await search(session, query, type);
      if (results.length > 0) { console.log(`[STREAM] ${results.length} results for "${query}"`); break; }
    }

    res.json({ streams: buildStreams(results, title, token) });
  } catch (err) {
    console.error("[STREAM ERROR]", err.message);
    if (err.message?.toLowerCase().includes("login")) invalidateSession(creds.username);
    res.json({ streams: [] });
  }
});

// ── Torrent proxy ─────────────────────────────────────────────────────────────
// Stremio calls this URL. We fetch the .torrent file from LM using the
// authenticated session (which has the right cookies) and pipe it back.
// This solves the "playback error" — Stremio was getting a 403/redirect
// because LM requires a logged-in session to download .torrent files.
app.get("/torrent-proxy/:token/:torrentId", async (req, res) => {
  const { token, torrentId } = req.params;
  const creds = decodeCredentials(token);
  if (!creds) return res.status(401).send("Invalid token");

  console.log(`[PROXY] Fetching torrent id=${torrentId} for ${creds.username}`);

  try {
    const session = await login(creds.username, creds.password);

    // Build the download URL, with passkey if available
    let dlUrl = `https://www.linkomanija.net/download.php?id=${torrentId}`;
    if (session.passkey) dlUrl += `&passkey=${session.passkey}`;

    const torrentResp = await session.client.get(dlUrl, {
      responseType: "arraybuffer",
      headers: { Accept: "application/x-bittorrent, */*" },
    });

    // Forward the .torrent file to Stremio
    res.setHeader("Content-Type", "application/x-bittorrent");
    res.setHeader("Content-Disposition", `attachment; filename="${torrentId}.torrent"`);
    res.send(Buffer.from(torrentResp.data));
    console.log(`[PROXY] Served ${torrentResp.data.byteLength} bytes for id=${torrentId}`);
  } catch (err) {
    console.error("[PROXY ERROR]", err.message);
    res.status(500).send("Failed to fetch torrent: " + err.message);
  }
});

// ── Debug endpoint ────────────────────────────────────────────────────────────
app.get("/debug", async (req, res) => {
  const { token, query, type } = req.query;
  if (!token || !query) {
    return res.send(`<!DOCTYPE html><html><head><style>
      body{font-family:monospace;background:#111;color:#eee;padding:20px}
      input,select{background:#222;color:#eee;border:1px solid #444;padding:8px;margin:8px 0;display:block;width:400px}
      button{background:#e8342a;color:#fff;border:none;padding:10px 20px;cursor:pointer;margin-top:8px}
    </style></head><body>
      <h2 style="color:#f5a623">🔍 LM Debug</h2>
      <form>
        <label>Token (from your manifest URL)</label>
        <input name="token" placeholder="paste token here" value="${token||""}"/>
        <label>Search query</label>
        <input name="query" placeholder="e.g. inception" value="${query||""}"/>
        <label>Type</label>
        <select name="type">
          <option value="movie" ${type==="movie"?"selected":""}>movie</option>
          <option value="series" ${type==="series"?"selected":""}>series</option>
        </select>
        <button type="submit">Run Debug →</button>
      </form>
    </body></html>`);
  }

  const creds = decodeCredentials(token);
  if (!creds) return res.send("<b style='color:red'>Invalid token</b>");

  try {
    const session = await login(creds.username, creds.password);
    const { html, url } = await debugSearch(session, query);

    const cheerio = require("cheerio");
    const $ = cheerio.load(html);

    const torrentRows = $("tr.torrenttable");
    const downloadLinks = $('a[href*="download.php"]');

    // Grab the first full torrent row HTML for inspection
    let firstRowHtml = "";
    if (torrentRows.length > 0) {
      firstRowHtml = $.html(torrentRows.first());
    }

    // Show td classes from first row
    let tdClasses = [];
    if (torrentRows.length > 0) {
      torrentRows.first().find("td").each((i, td) => {
        tdClasses.push(`td[${i}] class="${$(td).attr("class")||""}" text="${$(td).text().trim().substring(0,30)}"`);
      });
    }

    // Run actual parser and show results
    const { parseTorrentRowsDebug } = require("./linkomanija");
    const parsed = require("./linkomanija").parseTorrentRowsForDebug
      ? require("./linkomanija").parseTorrentRowsForDebug(html, session.passkey)
      : [];

    res.send(`<!DOCTYPE html><html><head><style>
      body{font-family:monospace;background:#111;color:#eee;padding:20px;font-size:13px}
      h2{color:#f5a623} h3{color:#22c55e;margin-top:1.5rem}
      pre{background:#1a1a1a;border:1px solid #333;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all}
      .good{color:#22c55e} .bad{color:#f87171} .warn{color:#f5a623}
      a{color:#60a5fa}
    </style></head><body>
      <h2>🔍 LM Debug — "${query}"</h2>
      <p>URL: <a href="${url}">${url}</a></p>
      <p>HTML size: ${html.length} bytes</p>

      <h3>Row counts</h3>
      <p class="${torrentRows.length>0?'good':'bad'}">tr.torrenttable rows: <b>${torrentRows.length}</b></p>
      <p class="${downloadLinks.length>0?'good':'bad'}">download.php links: <b>${downloadLinks.length}</b></p>

      <h3>TD breakdown of first torrent row</h3>
      <pre>${tdClasses.join("\n") || "(no rows found)"}</pre>

      <h3>First torrent row raw HTML</h3>
      <pre>${firstRowHtml.replace(/</g,"&lt;").replace(/>/g,"&gt;").substring(0,4000)}</pre>

      <p><a href="/debug?token=${encodeURIComponent(token)}&query=${encodeURIComponent(query)}&type=${type||'movie'}">↻ Refresh</a></p>
    </body></html>`);
  } catch (err) {
    res.send(`<b style="color:red">Error: ${err.message}</b><pre>${err.stack}</pre>`);
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", addonUrl: ADDON_URL }));

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   🇱🇹 Linkomanija Stremio Addon                  ║
╠══════════════════════════════════════════════════╣
║   Configure : ${ADDON_URL}/configure
║   Debug     : ${ADDON_URL}/debug
║   Health    : ${ADDON_URL}/health
╚══════════════════════════════════════════════════╝
  `);
});

// ── HTML Pages ────────────────────────────────────────────────────────────────
function configurePage(error = "") {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Linkomanija · Stremio Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0b0d0f;--surface:#13161a;--border:#1e2328;--accent:#e8342a;--accent2:#f5a623;--text:#e8e6e1;--muted:#6b7280}
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
    body::before{content:'';position:fixed;top:-30%;left:-10%;width:60%;height:60%;background:radial-gradient(ellipse,rgba(232,52,42,.12) 0%,transparent 70%);pointer-events:none;z-index:0}
    .card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:3rem;width:100%;max-width:460px;box-shadow:0 32px 80px rgba(0,0,0,.6);animation:fadeUp .5s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .logo-row{display:flex;align-items:center;gap:1rem;margin-bottom:2.5rem}
    .flag{font-size:2rem}.brand h1{font-family:'Bebas Neue',sans-serif;font-size:2.2rem;letter-spacing:.06em;line-height:1}
    .brand p{font-size:.78rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
    .divider{height:1px;background:var(--border);margin:0 0 2rem}
    label{display:block;font-size:.75rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem}
    input{width:100%;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem;color:var(--text);font-family:'DM Sans',sans-serif;font-size:.95rem;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:1.25rem}
    input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,52,42,.15)}
    input::placeholder{color:#3a3f47}
    button[type=submit]{width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:.9rem;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:.1em;cursor:pointer;transition:background .2s,transform .1s;margin-top:.5rem}
    button[type=submit]:hover{background:#c42720}button[type=submit]:active{transform:scale(.98)}
    .error{background:rgba(232,52,42,.1);border:1px solid rgba(232,52,42,.3);border-radius:8px;padding:.75rem 1rem;font-size:.875rem;color:#f87171;margin-bottom:1.5rem}
    .note{font-size:.78rem;color:var(--muted);text-align:center;margin-top:1.5rem;line-height:1.6}
    .note a{color:var(--accent2);text-decoration:none}
    .badge{display:inline-flex;align-items:center;gap:4px;background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.2);color:var(--accent2);font-size:.7rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:99px;margin-bottom:1.5rem}
  </style>
</head><body>
  <div class="card">
    <div class="logo-row"><span class="flag">🇱🇹</span><div class="brand"><h1>Linkomanija</h1><p>Stremio Addon · Private Tracker</p></div></div>
    <span class="badge">🔒 Credentials stay in your Stremio URL only</span>
    <div class="divider"></div>
    ${error ? `<div class="error">⚠ ${error}</div>` : ""}
    <form method="POST" action="/configure">
      <label for="u">Linkomanija Username</label>
      <input type="text" id="u" name="username" placeholder="your_username" autocomplete="username" required/>
      <label for="p">Password</label>
      <input type="password" id="p" name="password" placeholder="••••••••" autocomplete="current-password" required/>
      <button type="submit">Generate My Addon URL →</button>
    </form>
    <p class="note">Requires an active <a href="https://www.linkomanija.net" target="_blank">Linkomanija.net</a> account.<br/>Credentials are encoded in your URL — never stored on this server.</p>
  </div>
</body></html>`;
}

function successPage(manifestUrl, stremioUrl, username) {
  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Linkomanija · Ready</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0b0d0f;--surface:#13161a;--border:#1e2328;--accent:#e8342a;--accent2:#f5a623;--green:#22c55e;--text:#e8e6e1;--muted:#6b7280}
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
    body::before{content:'';position:fixed;top:-30%;left:-10%;width:60%;height:60%;background:radial-gradient(ellipse,rgba(34,197,94,.1) 0%,transparent 70%);pointer-events:none;z-index:0}
    .card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:3rem;width:100%;max-width:520px;box-shadow:0 32px 80px rgba(0,0,0,.6);animation:fadeUp .5s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .icon{font-size:3rem;margin-bottom:1rem}
    h1{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:.06em;margin-bottom:.4rem}
    .sub{color:var(--muted);font-size:.875rem;margin-bottom:2rem}
    .step-label{font-size:.7rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.6rem}
    .step-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:.7rem;font-weight:700;margin-right:6px}
    .url-box{background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;font-family:monospace;font-size:.75rem;color:#94a3b8;word-break:break-all;margin-bottom:.75rem}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:.75rem 1.5rem;border-radius:8px;border:none;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:.08em;cursor:pointer;text-decoration:none;transition:all .2s}
    .btn-primary{background:var(--accent);color:#fff}.btn-primary:hover{background:#c42720}
    .btn-secondary{background:transparent;color:var(--muted);border:1px solid var(--border)}.btn-secondary:hover{border-color:var(--muted);color:var(--text)}
    .btn-row{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.5rem}
    .divider{height:1px;background:var(--border);margin:1.5rem 0}
    .note{font-size:.78rem;color:var(--muted);line-height:1.7}
    .step{margin-bottom:1.5rem}
  </style>
</head><body>
  <div class="card">
    <div class="icon">✅</div>
    <h1>Ready, ${username}!</h1>
    <p class="sub">Your personal addon URL is generated.</p>
    <div class="step">
      <div class="step-label"><span class="step-num">1</span>One-click install</div>
      <a class="btn btn-primary" href="${stremioUrl}">⚡ Install in Stremio</a>
    </div>
    <div class="divider"></div>
    <div class="step">
      <div class="step-label"><span class="step-num">2</span>Or paste manifest URL manually in Stremio</div>
      <div class="url-box" id="mu">${manifestUrl}</div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="copyUrl()">📋 Copy</button>
        <a class="btn btn-secondary" href="/configure">← Back</a>
      </div>
    </div>
    <div class="divider"></div>
    <p class="note">
      🔒 Credentials encoded in URL — never stored.<br/>
      🎬 Movies + 📺 TV Series · 🟢 Freeleech sorted first<br/>
      ⚙️ Torrent proxy built-in — no cookie issues<br/><br/>
      <b>No streams?</b> Visit <span style="color:var(--accent2)">/debug</span> to diagnose.
    </p>
  </div>
  <script>
    function copyUrl(){
      navigator.clipboard.writeText(document.getElementById('mu').textContent).then(()=>{
        event.target.textContent='✅ Copied!';
        setTimeout(()=>event.target.textContent='📋 Copy',2000);
      });
    }
  </script>
</body></html>`;
}
