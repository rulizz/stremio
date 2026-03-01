/**
 * linkomanija.js — scraper + session manager
 * Fixed based on actual LM HTML structure:
 *  - Torrent rows are in <tr class="torrenttable">
 *  - Download links use /download.php (15 found per page)
 *  - Torrent name links DO NOT use details.php — they use a different pattern
 *  - Category params must be valid LM cat IDs
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const NodeCache = require("node-cache");

const BASE_URL = "https://www.linkomanija.net";
const BROWSE_URL = `${BASE_URL}/browse.php`;

const sessionCache = new NodeCache({ stdTTL: 28800, checkperiod: 600 });
const searchCache  = new NodeCache({ stdTTL: 900,   checkperiod: 120 });

// ── Category IDs (confirmed working from debug URL pattern) ──────────────────
// Debug showed the URL was using c52=1&c61=1 which don't exist.
// LM standard category IDs:
const MOVIE_CATS = [1, 2, 3];      // Movies SD, HD, 4K
const TV_CATS    = [7, 8, 9];      // TV SD, HD, 4K
// All cats combined (used as fallback)
const ALL_CATS   = [1, 2, 3, 7, 8, 9, 4, 5, 6, 10, 11, 12, 13, 14, 15];

function createClient() {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      baseURL: BASE_URL,
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "lt,en-US;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        Referer: BASE_URL + "/",
      },
    })
  );
  return { client };
}

// ── Login ─────────────────────────────────────────────────────────────────────
async function login(username, password) {
  const cacheKey = `session:${username}`;
  if (sessionCache.has(cacheKey)) return sessionCache.get(cacheKey);

  const { client } = createClient();

  const loginPage = await client.get("/login.php");
  const $ = cheerio.load(loginPage.data);

  const formData = new URLSearchParams();
  $("form input[type=hidden]").each((_, el) => {
    const name = $(el).attr("name");
    const value = $(el).attr("value") || "";
    if (name) formData.append(name, value);
  });
  formData.append("username", username);
  formData.append("password", password);
  formData.append("keeplogged", "1");
  formData.append("login", "submit");

  const loginResp = await client.post("/takelogin.php", formData.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: BASE_URL + "/login.php",
    },
    maxRedirects: 5,
  });

  const body = loginResp.data;
  const hasLogout =
    body.includes("logout.php") ||
    body.includes("atsijungti") ||
    body.includes("Atsijungti") ||
    body.includes("logout") ||
    body.includes("Logout");

  if (!hasLogout) {
    const snippet = body.substring(0, 500).replace(/\s+/g, " ");
    console.error("[LOGIN FAIL] Page snippet:", snippet);
    throw new Error("Login failed — check credentials.");
  }

  // Extract passkey
  let passkey = "";
  const passkeyMatch = body.match(/passkey=([a-f0-9]{32,40})/i);
  if (passkeyMatch) {
    passkey = passkeyMatch[1];
    console.log("[LOGIN] Passkey found:", passkey.substring(0, 8) + "...");
  } else {
    console.warn("[LOGIN] No passkey found — will try download links from page instead");
  }

  console.log("[LOGIN] Success for:", username);
  const session = { client, passkey, username };
  sessionCache.set(cacheKey, session);
  return session;
}

// ── Search ────────────────────────────────────────────────────────────────────
async function search(session, query, type = "movie") {
  const cacheKey = `search:${session.username}:${type}:${query}`;
  if (searchCache.has(cacheKey)) {
    console.log(`[SEARCH] Cache hit for "${query}"`);
    return searchCache.get(cacheKey);
  }

  // Use correct category IDs — no category filter = search all (most reliable)
  // LM accepts no category params to search everything
  const url = `${BROWSE_URL}?search=${encodeURIComponent(query)}&searchin=1&incldead=0`;

  console.log(`[SEARCH] Fetching: ${url}`);

  let html = "";
  try {
    const resp = await session.client.get(url);
    html = resp.data;
    console.log(`[SEARCH] Got ${html.length} bytes`);
  } catch (err) {
    console.error(`[SEARCH] HTTP error:`, err.message);
    return [];
  }

  const results = parseTorrentRows(html, session.passkey);
  console.log(`[SEARCH] Parsed ${results.length} torrents for "${query}"`);
  searchCache.set(cacheKey, results);
  return results;
}

// ── Debug ─────────────────────────────────────────────────────────────────────
async function debugSearch(session, query) {
  const url = `${BROWSE_URL}?search=${encodeURIComponent(query)}&searchin=1&incldead=0`;
  const resp = await session.client.get(url);
  return { html: resp.data, url };
}

// ── Parser ────────────────────────────────────────────────────────────────────
// Based on debug findings:
//   - TR class = "torrenttable"
//   - 15 download.php links per page (real torrents)
//   - Name links are NOT details.php — need to find name from the row differently
function parseTorrentRows(html, passkey) {
  const $ = cheerio.load(html);
  const torrents = [];

  // Primary strategy: find rows by tr.torrenttable
  // Each row contains a download.php link AND a torrent name
  $("tr.torrenttable").each((_, row) => {
    const $row = $(row);

    // Get the download link — this is the most reliable anchor
    const $dlLink = $row.find('a[href*="download.php"]').first();
    if (!$dlLink.length) return;

    const dlHref = $dlLink.attr("href") || "";
    const idMatch = dlHref.match(/[?&]id=(\d+)/);
    if (!idMatch) return;

    const id = idMatch[1];

    // Build download URL (prefer the actual link from page, add passkey if needed)
    let downloadUrl = dlHref.startsWith("http")
      ? dlHref
      : BASE_URL + (dlHref.startsWith("/") ? dlHref : "/" + dlHref);

    // Add passkey if not already in the URL
    if (passkey && !downloadUrl.includes("passkey=")) {
      downloadUrl += `&passkey=${passkey}`;
    }

    // Get torrent name — try multiple strategies
    let name = "";

    // Strategy A: find a link that looks like a torrent title
    // LM uses links like /details.php, /torrents.php, or anchor with torrent name
    $row.find("a").each((_, a) => {
      const href = $(a).attr("href") || "";
      const text = $(a).text().trim();
      // Skip download, user, category links — we want the title link
      if (
        text.length > 5 &&
        !href.includes("download.php") &&
        !href.includes("userdetails.php") &&
        !href.includes("login.php") &&
        !href.includes("logout.php") &&
        !href.includes("index.php") &&
        !href.includes("javascript") &&
        !name
      ) {
        name = text;
      }
    });

    // Strategy B: if no link found, grab the longest text cell
    if (!name) {
      $row.find("td").each((_, cell) => {
        const text = $(cell).text().trim();
        if (text.length > name.length && text.length > 10 && !/^\d+$/.test(text)) {
          name = text;
        }
      });
    }

    if (!name || name.length < 3) return;

    // Extract size, seeders, leechers from cells
    let size = "";
    let seeders = 0;
    let leechers = 0;

    $row.find("td").each((_, cell) => {
      const $cell = $(cell);
      const text = $cell.text().trim();
      const cls = ($cell.attr("class") || "").toLowerCase();

      // Size: "1.47 GB", "700.00 MB"
      if (!size && /^[\d.,]+\s*(GB|MB|KB|TB)/i.test(text)) {
        size = text;
      }

      // Seeders: green-ish class or "seed" in class name
      if ((cls.includes("seed") || cls.includes("green") || cls === "sl") && !seeders) {
        const n = parseInt(text.replace(/\D/g, ""), 10);
        if (!isNaN(n)) seeders = n;
      }

      // Leechers: red-ish class
      if ((cls.includes("leech") || cls.includes("red")) && !leechers) {
        const n = parseInt(text.replace(/\D/g, ""), 10);
        if (!isNaN(n)) leechers = n;
      }
    });

    // Freeleech
    const rowHtml = ($row.html() || "").toLowerCase();
    const freeleech =
      rowHtml.includes("freeleech") ||
      rowHtml.includes("free leech") ||
      $row.find("[class*='free'], .fl").length > 0;

    torrents.push({
      id,
      name,
      downloadUrl,
      size,
      seeders,
      leechers,
      freeleech,
      quality: detectQuality(name),
    });
  });

  // Deduplicate by id
  const seen = new Set();
  return torrents.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}

function detectQuality(name) {
  const n = name.toUpperCase();
  if (n.includes("2160") || n.includes("4K") || n.includes("UHD")) return "4K";
  if (n.includes("1080")) return n.includes("BLURAY") || n.includes("BLU-RAY") ? "1080p BluRay" : "1080p";
  if (n.includes("720")) return "720p";
  if (n.includes("BLURAY") || n.includes("BLU-RAY")) return "BluRay";
  if (n.includes("DVDRIP") || n.includes("DVD")) return "DVDRip";
  if (n.includes("HDTV")) return "HDTV";
  if (n.includes("WEBRIP") || n.includes("WEB-DL") || n.includes("WEB.DL")) return "WEB";
  return "SD";
}

function invalidateSession(username) {
  sessionCache.del(`session:${username}`);
}

module.exports = { login, search, debugSearch, invalidateSession };
