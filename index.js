/**
 * index.js — Linkomanija Stremio Addon
 * ─────────────────────────────────────
 * A public-hosted Stremio addon that scrapes Linkomanija.net.
 *
 * Flow:
 *   1. User visits /configure → enters LM username+password → gets a personal manifest URL
 *   2. Stremio fetches /:user/:token/manifest.json
 *   3. When user clicks a Movie/TV stream, Stremio calls /:user/:token/stream/movie/tt1234567.json
 *   4. Addon logs in to LM (cached), searches by title, returns stream list
 *
 * Credentials are base64-encoded in the URL token. This is NOT bulletproof
 * security, but it's the standard approach for personal/private Stremio addons
 * (same pattern used by Torrentio, Debrid addons, etc.).
 * The addon does NOT store credentials — they live only in the user's Stremio URL.
 */

const express = require("express");
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");
const { login, search, invalidateSession } = require("./linkomanija");

const PORT = process.env.PORT || 3000;
const ADDON_URL = process.env.ADDON_URL || `http://localhost:${PORT}`;

// ── IMDB title lookup (free, no key required) ───────────────────────────────
async function getImdbTitle(imdbId) {
  try {
    // Use the Stremio Cinemeta API — fast, free, no rate limits for addons
    const url = `https://v3.sg.media-imdb.com/suggestion/t/${imdbId}.json`;
    // Simpler: use Cinemeta
    const resp = await axios.get(
      `https://cinemeta-live.strem.io/meta/movie/${imdbId}.json`,
      { timeout: 8000 }
    );
    return resp.data?.meta?.name || null;
  } catch {
    try {
      const resp = await axios.get(
        `https://cinemeta-live.strem.io/meta/series/${imdbId}.json`,
        { timeout: 8000 }
      );
      return resp.data?.meta?.name || null;
    } catch {
      return null;
    }
  }
}

// ── Credential helpers ───────────────────────────────────────────────────────
function encodeCredentials(username, password) {
  return Buffer.from(JSON.stringify({ username, password })).toString("base64url");
}

function decodeCredentials(token) {
  try {
    const json = Buffer.from(token, "base64url").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ── Build Stremio streams from LM results ───────────────────────────────────
function buildStreams(torrents, title) {
  return torrents
    .filter((t) => t.seeders > 0 || true) // include even unseeded so user sees them
    .sort((a, b) => {
      // Sort: freeleech first, then by quality, then seeders
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
    .map((t) => {
      const fl = t.freeleech ? " 🟢 FL" : "";
      const seeds = t.seeders > 0 ? `👤 ${t.seeders}` : "💀 0";
      return {
        name: `🇱🇹 Linkomanija\n${t.quality}${fl}`,
        description: `${t.name}\n💾 ${t.size || "?"} | ${seeds} | ⬇ ${t.leechers}`,
        url: t.downloadUrl,  // .torrent file URL — Stremio handles download
        // Optional: behaviorHints
        behaviorHints: {
          notWebReady: true,
          // bingeGroup ensures sequential episode tracking for TV
          bingeGroup: `lm-${title}`,
        },
      };
    })
    .slice(0, 20); // cap at 20 results
}

// ── Express app ──────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — required for Stremio
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  next();
});

// ── Configure page ───────────────────────────────────────────────────────────
app.get("/", (req, res) => res.redirect("/configure"));
app.get("/configure", (req, res) => {
  res.send(configurePage());
});

app.post("/configure", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.send(configurePage("Username and password are required."));
  }
  const token = encodeCredentials(username.trim(), password);
  const manifestUrl = `${ADDON_URL}/${token}/manifest.json`;
  const stremioUrl = `stremio://${new URL(ADDON_URL).host}/${token}/manifest.json`;
  res.send(successPage(manifestUrl, stremioUrl, username.trim()));
});

// ── Manifest (per user, credentials in URL) ──────────────────────────────────
app.get("/:token/manifest.json", (req, res) => {
  const creds = decodeCredentials(req.params.token);
  if (!creds) return res.status(400).json({ error: "Invalid token" });

  res.json({
    id: `community.linkomanija.${creds.username}`,
    version: "1.0.0",
    name: `🇱🇹 Linkomanija (${creds.username})`,
    description:
      "Streams from Linkomanija.net — Lithuanian private torrent tracker. " +
      "Provides Movies & TV Shows.",
    logo: "https://www.linkomanija.net/favicon.ico",
    background:
      "https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=1280&q=80",
    resources: ["stream"],
    types: ["movie", "series"],
    catalogs: [],
    behaviorHints: {
      configurable: true,
      configurationRequired: false,
    },
  });
});

// ── Stream handler ────────────────────────────────────────────────────────────
app.get("/:token/stream/:type/:id.json", async (req, res) => {
  const { token, type, id } = req.params;

  const creds = decodeCredentials(token);
  if (!creds) return res.json({ streams: [] });

  const imdbId = id.split(":")[0]; // Stremio sends "tt1234567" or "tt1234567:1:2"
  const season = id.includes(":") ? id.split(":")[1] : null;
  const episode = id.includes(":") ? id.split(":")[2] : null;

  console.log(`[STREAM] ${type} | ${id} | user=${creds.username}`);

  try {
    // 1. Ensure we have a valid LM session
    let session;
    try {
      session = await login(creds.username, creds.password);
    } catch (err) {
      console.error("[AUTH] Login failed:", err.message);
      return res.json({
        streams: [
          {
            name: "❌ Linkomanija",
            description: `Login failed: ${err.message}`,
            externalUrl: "https://www.linkomanija.net",
          },
        ],
      });
    }

    // 2. Resolve IMDB ID → title
    let title = await getImdbTitle(imdbId);
    if (!title) {
      console.warn(`[IMDB] Could not resolve title for ${imdbId}`);
      return res.json({ streams: [] });
    }

    // 3. Build search query
    let query = title;
    if (type === "series" && season && episode) {
      const s = String(season).padStart(2, "0");
      const e = String(episode).padStart(2, "0");
      query = `${title} S${s}E${e}`;
    }

    console.log(`[SEARCH] query="${query}" type=${type}`);

    // 4. Search LM
    let results = await search(session, query, type);

    // If episode search returns nothing, fall back to just title + season
    if (results.length === 0 && type === "series" && season) {
      const fallback = `${title} S${String(season).padStart(2, "0")}`;
      results = await search(session, fallback, type);
    }

    // If still nothing, try just the title
    if (results.length === 0) {
      results = await search(session, title, type);
    }

    const streams = buildStreams(results, title);
    console.log(`[RESULT] ${streams.length} streams for "${query}"`);

    res.json({ streams });
  } catch (err) {
    console.error("[STREAM ERROR]", err.message);
    // If auth error, invalidate session so next request triggers re-login
    if (err.message?.toLowerCase().includes("login")) {
      invalidateSession(creds.username);
    }
    res.json({ streams: [] });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", version: "1.0.0" }));

// ── HTML pages ────────────────────────────────────────────────────────────────
function configurePage(error = "") {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Linkomanija · Stremio Addon</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0b0d0f;
      --surface: #13161a;
      --border: #1e2328;
      --accent: #e8342a;
      --accent2: #f5a623;
      --text: #e8e6e1;
      --muted: #6b7280;
    }

    body {
      background: var(--bg);
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      overflow: hidden;
    }

    /* Ambient background glow */
    body::before {
      content: '';
      position: fixed;
      top: -30%;
      left: -10%;
      width: 60%;
      height: 60%;
      background: radial-gradient(ellipse, rgba(232,52,42,0.12) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }
    body::after {
      content: '';
      position: fixed;
      bottom: -20%;
      right: -10%;
      width: 50%;
      height: 50%;
      background: radial-gradient(ellipse, rgba(245,166,35,0.08) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .card {
      position: relative;
      z-index: 1;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 3rem;
      width: 100%;
      max-width: 460px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03);
    }

    .logo-row {
      display: flex;
      align-items: center;
      gap: 1rem;
      margin-bottom: 2.5rem;
    }

    .flag {
      font-size: 2rem;
      line-height: 1;
    }

    .brand h1 {
      font-family: 'Bebas Neue', sans-serif;
      font-size: 2.2rem;
      letter-spacing: 0.06em;
      line-height: 1;
      color: var(--text);
    }

    .brand p {
      font-size: 0.78rem;
      color: var(--muted);
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-top: 2px;
    }

    .divider {
      height: 1px;
      background: var(--border);
      margin: 0 0 2rem;
    }

    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 500;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }

    input {
      width: 100%;
      background: #0b0d0f;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.85rem 1rem;
      color: var(--text);
      font-family: 'DM Sans', sans-serif;
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s, box-shadow 0.2s;
      margin-bottom: 1.25rem;
    }

    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(232,52,42,0.15);
    }

    input::placeholder { color: #3a3f47; }

    button[type=submit] {
      width: 100%;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 0.9rem;
      font-family: 'Bebas Neue', sans-serif;
      font-size: 1.1rem;
      letter-spacing: 0.1em;
      cursor: pointer;
      transition: background 0.2s, transform 0.1s;
      margin-top: 0.5rem;
    }

    button[type=submit]:hover { background: #c42720; }
    button[type=submit]:active { transform: scale(0.98); }

    .error {
      background: rgba(232,52,42,0.1);
      border: 1px solid rgba(232,52,42,0.3);
      border-radius: 8px;
      padding: 0.75rem 1rem;
      font-size: 0.875rem;
      color: #f87171;
      margin-bottom: 1.5rem;
    }

    .note {
      font-size: 0.78rem;
      color: var(--muted);
      text-align: center;
      margin-top: 1.5rem;
      line-height: 1.6;
    }

    .note a { color: var(--accent2); text-decoration: none; }
    .note a:hover { text-decoration: underline; }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(245,166,35,0.12);
      border: 1px solid rgba(245,166,35,0.2);
      color: var(--accent2);
      font-size: 0.7rem;
      font-weight: 500;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 99px;
      margin-bottom: 1.5rem;
    }

    @keyframes fadeUp {
      from { opacity: 0; transform: translateY(20px); }
      to   { opacity: 1; transform: translateY(0); }
    }
    .card { animation: fadeUp 0.5s ease both; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo-row">
      <span class="flag">🇱🇹</span>
      <div class="brand">
        <h1>Linkomanija</h1>
        <p>Stremio Addon · Private Tracker</p>
      </div>
    </div>

    <span class="badge">🔒 Your credentials stay in your Stremio URL</span>

    <div class="divider"></div>

    ${error ? `<div class="error">⚠ ${error}</div>` : ""}

    <form method="POST" action="/configure">
      <label for="username">Linkomanija Username</label>
      <input type="text" id="username" name="username" placeholder="your_username" autocomplete="username" required />

      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="••••••••" autocomplete="current-password" required />

      <button type="submit">Generate My Addon URL →</button>
    </form>

    <p class="note">
      You need an active <a href="https://www.linkomanija.net" target="_blank">Linkomanija.net</a> account.<br/>
      Credentials are encoded directly in your personal manifest URL<br/>and are never stored on this server.
    </p>
  </div>
</body>
</html>`;
}

function successPage(manifestUrl, stremioUrl, username) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Linkomanija · Installed</title>
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@300;400;500&display=swap" rel="stylesheet" />
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0b0d0f; --surface: #13161a; --border: #1e2328;
      --accent: #e8342a; --accent2: #f5a623; --green: #22c55e;
      --text: #e8e6e1; --muted: #6b7280;
    }
    body {
      background: var(--bg); color: var(--text);
      font-family: 'DM Sans', sans-serif;
      min-height: 100vh; display: flex;
      align-items: center; justify-content: center; padding: 2rem;
    }
    body::before {
      content: ''; position: fixed; top: -30%; left: -10%;
      width: 60%; height: 60%;
      background: radial-gradient(ellipse, rgba(34,197,94,0.1) 0%, transparent 70%);
      pointer-events: none; z-index: 0;
    }
    .card {
      position: relative; z-index: 1;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 16px; padding: 3rem; width: 100%; max-width: 520px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.6);
      animation: fadeUp 0.5s ease both;
    }
    @keyframes fadeUp {
      from { opacity:0; transform:translateY(20px); }
      to   { opacity:1; transform:translateY(0); }
    }
    .success-icon { font-size: 3rem; margin-bottom: 1rem; }
    h1 { font-family: 'Bebas Neue', sans-serif; font-size: 2rem; letter-spacing: 0.06em; margin-bottom: 0.4rem; }
    .sub { color: var(--muted); font-size: 0.875rem; margin-bottom: 2rem; }
    .step { margin-bottom: 1.5rem; }
    .step-label {
      font-size: 0.7rem; font-weight: 500; letter-spacing: 0.1em;
      text-transform: uppercase; color: var(--muted); margin-bottom: 0.4rem;
    }
    .step-num {
      display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--accent); color: #fff;
      font-size: 0.7rem; font-weight: 700; margin-right: 6px;
    }
    .url-box {
      background: #0b0d0f; border: 1px solid var(--border); border-radius: 8px;
      padding: 0.75rem 1rem; font-family: monospace; font-size: 0.78rem;
      color: #94a3b8; word-break: break-all; margin-bottom: 0.75rem;
    }
    .btn {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 0.75rem 1.5rem; border-radius: 8px; border: none;
      font-family: 'Bebas Neue', sans-serif; font-size: 1rem; letter-spacing: 0.08em;
      cursor: pointer; text-decoration: none; transition: all 0.2s;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: #c42720; }
    .btn-secondary {
      background: transparent; color: var(--muted);
      border: 1px solid var(--border); font-size: 0.85rem;
    }
    .btn-secondary:hover { border-color: var(--muted); color: var(--text); }
    .btn-row { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-top: 0.5rem; }
    .divider { height: 1px; background: var(--border); margin: 1.5rem 0; }
    .note { font-size: 0.78rem; color: var(--muted); line-height: 1.6; }
    .copied { color: var(--green) !important; }
  </style>
</head>
<body>
  <div class="card">
    <div class="success-icon">✅</div>
    <h1>You're all set, ${username}!</h1>
    <p class="sub">Your personal Linkomanija addon URL is ready.</p>

    <div class="step">
      <div class="step-label"><span class="step-num">1</span> Click to install in Stremio</div>
      <a class="btn btn-primary" href="${stremioUrl}">⚡ Install in Stremio</a>
    </div>

    <div class="divider"></div>

    <div class="step">
      <div class="step-label"><span class="step-num">2</span> Or copy manifest URL manually</div>
      <div class="url-box" id="manifestUrl">${manifestUrl}</div>
      <div class="btn-row">
        <button class="btn btn-secondary" onclick="copyUrl()">📋 Copy URL</button>
        <a class="btn btn-secondary" href="/configure">← Configure Again</a>
      </div>
    </div>

    <div class="divider"></div>

    <p class="note">
      🔒 Your credentials are encoded in the URL above — nobody can read them unless they have your URL.<br/><br/>
      📦 The addon supports <strong>Movies</strong> and <strong>TV Series</strong>.<br/>
      🟢 Freeleech torrents are marked and sorted first.<br/>
      🔄 Sessions are cached for 8 hours. Results cached for 15 minutes.
    </p>
  </div>

  <script>
    function copyUrl() {
      const url = document.getElementById('manifestUrl').textContent;
      navigator.clipboard.writeText(url).then(() => {
        const btn = event.target;
        btn.textContent = '✅ Copied!';
        btn.classList.add('copied');
        setTimeout(() => { btn.textContent = '📋 Copy URL'; btn.classList.remove('copied'); }, 2000);
      });
    }
  </script>
</body>
</html>`;
}

// ── Start server ──────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🇱🇹 Linkomanija Stremio Addon                      ║
╠══════════════════════════════════════════════════════╣
║   Configure : ${ADDON_URL}/configure
║   Health    : ${ADDON_URL}/health
╚══════════════════════════════════════════════════════╝
  `);
});
