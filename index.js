/**
 * index.js — Linkomanija Stremio Addon
 */

const express = require("express");
const axios = require("axios");
const { login, search, debugSearch, invalidateSession } = require("./linkomanija");

const PORT = process.env.PORT || 3000;
const ADDON_URL = (process.env.ADDON_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

// ── IMDB → title via Cinemeta ─────────────────────────────────────────────────
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
  } catch {
    return null;
  }
}

// ── Build stream list ─────────────────────────────────────────────────────────
function buildStreams(torrents, title) {
  return torrents
    .sort((a, b) => {
      if (a.freeleech !== b.freeleech) return b.freeleech ? 1 : -1;
      const qScore = (q) => {
        if (q.includes("4K")) return 4;
        if (q.includes("1080")) return 3;
        if (q.includes("720")) return 2;
        return 1;
      };
      const qDiff = qScore(b.quality) - qScore(a.quality);
      if (qDiff !== 0) return qDiff;
      return b.seeders - a.seeders;
    })
    .map((t) => ({
      name: `🇱🇹 Linkomanija\n${t.quality}${t.freeleech ? " 🟢 FL" : ""}`,
      description: `${t.name}\n💾 ${t.size || "?"} | 👤 ${t.seeders} | ⬇ ${t.leechers}`,
      url: t.downloadUrl,
      behaviorHints: { notWebReady: true, bingeGroup: `lm-${title}` },
    }))
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

// ── Root → configure ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => res.send(configurePage()));

app.post("/configure", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.send(configurePage("Username and password are required."));
  const token = encodeCredentials(username.trim(), password);
  const manifestUrl = `${ADDON_URL}/${token}/manifest.json`;
  // stremio:// uses the host only, not the full URL
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
    version: "1.0.0",
    name: `🇱🇹 Linkomanija (${creds.username})`,
    description: "Streams from Linkomanija.net — Lithuanian private torrent tracker.",
    logo: "https://www.linkomanija.net/favicon.ico",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    // ✅ THIS is what makes the Configure button work in Stremio
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
    // ✅ THIS is the URL Stremio opens when you click Configure
    configureUrl: `${ADDON_URL}/configure`,
  });
});

// ── Stream handler ────────────────────────────────────────────────────────────
app.get("/:token/stream/:type/:id.json", async (req, res) => {
  const { token, type, id } = req.params;
  const creds = decodeCredentials(token);
  if (!creds) return res.json({ streams: [] });

  const imdbId = id.split(":")[0];
  const season  = id.includes(":") ? id.split(":")[1] : null;
  const episode = id.includes(":") ? id.split(":")[2] : null;

  console.log(`[STREAM] ${type} | ${id} | user=${creds.username}`);

  try {
    const session = await login(creds.username, creds.password);

    const title = await getImdbTitle(imdbId, type);
    if (!title) {
      console.warn("[IMDB] Could not resolve title for", imdbId);
      return res.json({ streams: [] });
    }

    console.log(`[IMDB] Resolved: "${title}"`);

    // Build search query — most specific first, fallback to broader
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
      if (results.length > 0) {
        console.log(`[STREAM] Found ${results.length} results with query: "${query}"`);
        break;
      }
      console.log(`[STREAM] No results for query: "${query}", trying next...`);
    }

    res.json({ streams: buildStreams(results, title) });
  } catch (err) {
    console.error("[STREAM ERROR]", err.message);
    if (err.message?.toLowerCase().includes("login")) invalidateSession(creds.username);
    res.json({ streams: [] });
  }
});

// ── Debug endpoint — view raw LM HTML in your browser ────────────────────────
// Usage: /debug?token=YOUR_TOKEN&query=inception&type=movie
app.get("/debug", async (req, res) => {
  const { token, query, type } = req.query;
  if (!token || !query) {
    return res.send(`
      <h2>LM Debug</h2>
      <form>
        <input name="token" placeholder="your token" value="${token||""}" style="width:400px"/><br/><br/>
        <input name="query" placeholder="search query e.g. inception" value="${query||""}"/><br/><br/>
        <select name="type"><option value="movie">movie</option><option value="series">series</option></select><br/><br/>
        <button type="submit">Debug Search</button>
      </form>
    `);
  }

  const creds = decodeCredentials(token);
  if (!creds) return res.send("<b>Invalid token</b>");

  try {
    const session = await login(creds.username, creds.password);
    const { html, url } = await debugSearch(session, query, type || "movie");

    // Parse and show what we found
    const cheerio = require("cheerio");
    const $ = cheerio.load(html);
    const detailLinks = $('a[href*="details.php?id="]');
    const downloadLinks = $('a[href*="download.php"]');

    // Collect all unique table classes
    const tableClasses = new Set();
    $("table").each((_, t) => { if ($(t).attr("class")) tableClasses.add($(t).attr("class")); });

    // Collect all tr classes
    const trClasses = new Set();
    $("tr").each((_, t) => { if ($(t).attr("class")) trClasses.add($(t).attr("class")); });

    res.send(`
      <html><head><style>
        body { font-family: monospace; background: #111; color: #eee; padding: 20px; }
        h2 { color: #f5a623; } h3 { color: #22c55e; }
        pre { background: #222; padding: 10px; overflow-x: auto; font-size: 12px; }
        .good { color: #22c55e; } .bad { color: #f87171; }
        ul { line-height: 2; }
      </style></head><body>
      <h2>🔍 LM Debug Results</h2>
      <p><b>URL fetched:</b> <a href="${url}" style="color:#60a5fa">${url}</a></p>
      <p><b>HTML size:</b> ${html.length} bytes</p>

      <h3>Diagnostic</h3>
      <p class="${detailLinks.length > 0 ? 'good' : 'bad'}">
        ✅ detail links found (a[href*="details.php?id="]): <b>${detailLinks.length}</b>
      </p>
      <p>⬇ download links found (a[href*="download.php"]): <b>${downloadLinks.length}</b></p>

      <h3>Table classes on page</h3>
      <pre>${[...tableClasses].join("\n") || "(none)"}</pre>

      <h3>TR classes on page (first 20)</h3>
      <pre>${[...trClasses].slice(0,20).join("\n") || "(none)"}</pre>

      <h3>First 5 detail links found</h3>
      <ul>
        ${detailLinks.slice(0,5).map((_, l) =>
          `<li>${$(l).attr("href")} → <b>${$(l).text().trim()}</b></li>`
        ).get().join("")}
      </ul>

      <h3>Raw HTML (first 3000 chars)</h3>
      <pre>${html.substring(0, 3000).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre>

      <p><a href="/debug?token=${token}&query=${query}&type=${type||'movie'}" style="color:#f5a623">↻ Refresh</a></p>
      </body></html>
    `);
  } catch (err) {
    res.send(`<b style="color:red">Error: ${err.message}</b><br/><pre>${err.stack}</pre>`);
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
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
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
    .flag{font-size:2rem}
    .brand h1{font-family:'Bebas Neue',sans-serif;font-size:2.2rem;letter-spacing:.06em;line-height:1}
    .brand p{font-size:.78rem;color:var(--muted);letter-spacing:.08em;text-transform:uppercase;margin-top:2px}
    .divider{height:1px;background:var(--border);margin:0 0 2rem}
    label{display:block;font-size:.75rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.5rem}
    input{width:100%;background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.85rem 1rem;color:var(--text);font-family:'DM Sans',sans-serif;font-size:.95rem;outline:none;transition:border-color .2s,box-shadow .2s;margin-bottom:1.25rem}
    input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(232,52,42,.15)}
    input::placeholder{color:#3a3f47}
    button[type=submit]{width:100%;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:.9rem;font-family:'Bebas Neue',sans-serif;font-size:1.1rem;letter-spacing:.1em;cursor:pointer;transition:background .2s,transform .1s;margin-top:.5rem}
    button[type=submit]:hover{background:#c42720}
    button[type=submit]:active{transform:scale(.98)}
    .error{background:rgba(232,52,42,.1);border:1px solid rgba(232,52,42,.3);border-radius:8px;padding:.75rem 1rem;font-size:.875rem;color:#f87171;margin-bottom:1.5rem}
    .note{font-size:.78rem;color:var(--muted);text-align:center;margin-top:1.5rem;line-height:1.6}
    .note a{color:var(--accent2);text-decoration:none}
    .badge{display:inline-flex;align-items:center;gap:4px;background:rgba(245,166,35,.12);border:1px solid rgba(245,166,35,.2);color:var(--accent2);font-size:.7rem;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:99px;margin-bottom:1.5rem}
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-row">
      <span class="flag">🇱🇹</span>
      <div class="brand"><h1>Linkomanija</h1><p>Stremio Addon · Private Tracker</p></div>
    </div>
    <span class="badge">🔒 Credentials stay in your Stremio URL only</span>
    <div class="divider"></div>
    ${error ? `<div class="error">⚠ ${error}</div>` : ""}
    <form method="POST" action="/configure">
      <label for="username">Linkomanija Username</label>
      <input type="text" id="username" name="username" placeholder="your_username" autocomplete="username" required/>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" autocomplete="current-password" required/>
      <button type="submit">Generate My Addon URL →</button>
    </form>
    <p class="note">
      You need an active <a href="https://www.linkomanija.net" target="_blank">Linkomanija.net</a> account.<br/>
      Credentials are encoded in your manifest URL and never stored on this server.
    </p>
  </div>
</body>
</html>`;
}

function successPage(manifestUrl, stremioUrl, username) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Linkomanija · Installed</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet"/>
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    :root{--bg:#0b0d0f;--surface:#13161a;--border:#1e2328;--accent:#e8342a;--accent2:#f5a623;--green:#22c55e;--text:#e8e6e1;--muted:#6b7280}
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
    body::before{content:'';position:fixed;top:-30%;left:-10%;width:60%;height:60%;background:radial-gradient(ellipse,rgba(34,197,94,.1) 0%,transparent 70%);pointer-events:none;z-index:0}
    .card{position:relative;z-index:1;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:3rem;width:100%;max-width:520px;box-shadow:0 32px 80px rgba(0,0,0,.6);animation:fadeUp .5s ease both}
    @keyframes fadeUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
    .success-icon{font-size:3rem;margin-bottom:1rem}
    h1{font-family:'Bebas Neue',sans-serif;font-size:2rem;letter-spacing:.06em;margin-bottom:.4rem}
    .sub{color:var(--muted);font-size:.875rem;margin-bottom:2rem}
    .step{margin-bottom:1.5rem}
    .step-label{font-size:.7rem;font-weight:500;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:.4rem}
    .step-num{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;background:var(--accent);color:#fff;font-size:.7rem;font-weight:700;margin-right:6px}
    .url-box{background:#0b0d0f;border:1px solid var(--border);border-radius:8px;padding:.75rem 1rem;font-family:monospace;font-size:.78rem;color:#94a3b8;word-break:break-all;margin-bottom:.75rem}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:.75rem 1.5rem;border-radius:8px;border:none;font-family:'Bebas Neue',sans-serif;font-size:1rem;letter-spacing:.08em;cursor:pointer;text-decoration:none;transition:all .2s}
    .btn-primary{background:var(--accent);color:#fff}
    .btn-primary:hover{background:#c42720}
    .btn-secondary{background:transparent;color:var(--muted);border:1px solid var(--border);font-size:.85rem}
    .btn-secondary:hover{border-color:var(--muted);color:var(--text)}
    .btn-row{display:flex;gap:.75rem;flex-wrap:wrap;margin-top:.5rem}
    .divider{height:1px;background:var(--border);margin:1.5rem 0}
    .note{font-size:.78rem;color:var(--muted);line-height:1.6}
    .green{color:var(--green)}
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">✅</div>
    <h1>You're all set, ${username}!</h1>
    <p class="sub">Your personal Linkomanija addon URL is ready.</p>
    <div class="step">
      <div class="step-label"><span class="step-num">1</span> One-click install</div>
      <a class="btn btn-primary" href="${stremioUrl}">⚡ Install in Stremio</a>
    </div>
    <div class="divider"></div>
    <div class="step">
      <div class="step-label"><span class="step-num">2</span> Or copy manifest URL manually</div>
      <div class="url-box" id="manifestUrl">${manifestUrl}</div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="copyUrl()">📋 Copy URL</button>
        <a class="btn btn-secondary" href="/configure">← Back</a>
      </div>
    </div>
    <div class="divider"></div>
    <p class="note">
      🔒 Credentials encoded in URL — never stored on server.<br/>
      🟢 Freeleech torrents sorted first · 🎬 Movies + 📺 TV Series supported.<br/><br/>
      <b>If you see no streams:</b> visit <span style="color:var(--accent2)">${manifestUrl.split('/')[2]}/debug</span> to diagnose.
    </p>
  </div>
  <script>
    function copyUrl() {
      navigator.clipboard.writeText(document.getElementById('manifestUrl').textContent).then(() => {
        event.target.textContent = '✅ Copied!';
        setTimeout(() => event.target.textContent = '📋 Copy URL', 2000);
      });
    }
  </script>
</body>
</html>`;
}
