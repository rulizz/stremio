# 🇱🇹 Linkomanija — Stremio Addon

A personal Stremio addon that pulls torrent streams from [Linkomanija.net](https://www.linkomanija.net), the largest private Lithuanian torrent tracker.

---

## ✨ Features

- 🎬 **Movies** (SD, HD, 4K)
- 📺 **TV Series** (season + episode aware)
- 🟢 **Freeleech** torrents highlighted and sorted first
- 🔒 Credentials stay in your personal URL — never stored on the server
- ⚡ Session + result caching (8h / 15min)
- 🔍 Smart fallback search (episode → season → title)

---

## 🚀 Quick Deploy (Render.com — Free)

1. Fork / push this repo to GitHub
2. Go to [render.com](https://render.com) → **New Web Service**
3. Connect your repo
4. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Environment Variable**: `ADDON_URL=https://your-service.onrender.com`
5. Deploy → visit `https://your-service.onrender.com/configure`

---

## 🐳 Docker

```bash
docker build -t lm-stremio .
docker run -p 3000:3000 -e ADDON_URL=http://localhost:3000 lm-stremio
```

---

## 💻 Local Development

```bash
npm install
cp .env.example .env
# Edit .env — set ADDON_URL=http://localhost:3000
node index.js
# Open http://localhost:3000/configure
```

---

## 🔧 How It Works

```
Stremio
  │  stream request (IMDB ID)
  ▼
Addon Server
  │  1. Decode credentials from URL token
  │  2. Login to Linkomanija (cached 8h)
  │  3. Resolve IMDB ID → title via Cinemeta API
  │  4. Search linkomanija.net/browse.php
  │  5. Parse HTML torrent table with Cheerio
  │  6. Return sorted stream list
  ▼
Stremio renders stream list → user clicks → torrent downloads
```

---

## 📁 Project Structure

```
index.js          — Express server, routes, HTML pages
linkomanija.js    — LM login + search + HTML parser
package.json
Dockerfile
.env.example
```

---

## ⚠️ Notes

- Requires a valid **Linkomanija.net** account (invite-only tracker)
- The addon scrapes the site's HTML — if LM changes their layout, selectors may need updating
- Using this addon is **your responsibility** — respect Linkomanija's rules (ratio, etc.)
- The `.torrent` file URL requires your LM session cookie, so Stremio must pass it correctly. If downloads don't work, check your LM passkey in the URL.

---

## 🛠 Troubleshooting

| Problem | Fix |
|---|---|
| Login failed | Wrong credentials, or LM is temporarily blocking your IP |
| No streams found | Title resolution failed, or LM has no matching torrent |
| Streams appear but don't load | Stremio needs a torrent client or Debrid service |
| Session expired | The addon auto re-logins; try again in a moment |

---

## 📝 Category IDs Used

| ID | Type |
|---|---|
| 1, 2, 3, 22, 23, 42 | Movies (SD/HD/4K/Foreign) |
| 7, 8, 9, 24, 25 | TV Shows (SD/HD/4K/Foreign) |

*If LM changes their category IDs, update `MOVIE_CATS` / `TV_CATS` in `linkomanija.js`.*
