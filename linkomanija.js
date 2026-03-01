/**
 * linkomanija.js
 * ──────────────
 * Handles all communication with linkomanija.net:
 *   1. Login (POST form + keep session cookie)
 *   2. Search by text query  (used for title lookup)
 *   3. Parse torrent rows → structured objects
 *
 * Linkomanija uses a classic PHP tracker layout (similar to TorrentBytes / old BitHumen):
 *   Login  : POST https://www.linkomanija.net/takelogin.php
 *   Browse : GET  https://www.linkomanija.net/browse.php?search=<q>&cat=<id>
 *   Torrent: GET  https://www.linkomanija.net/download.php?id=<id>&passkey=<pk>
 *
 * Category IDs confirmed from Jackett releases & community notes:
 *   1  = Movies (SD)
 *   2  = Movies (HD)
 *   3  = Movies (4K/UHD)
 *   7  = TV Shows (SD)
 *   8  = TV Shows (HD)
 *   9  = TV Shows (4K/UHD)
 *  (others: music=4, games=5, anime=11, docs=14, etc.)
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const NodeCache = require("node-cache");

const BASE_URL = "https://www.linkomanija.net";
const LOGIN_URL = `${BASE_URL}/takelogin.php`;
const BROWSE_URL = `${BASE_URL}/browse.php`;

// Cache sessions per user for 8 hours so we don't hammer the login endpoint
const sessionCache = new NodeCache({ stdTTL: 28800, checkperiod: 600 });
// Cache search results for 15 minutes
const searchCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

// ── Category mapping ─────────────────────────────────────────────────────────
const MOVIE_CATS = [61, 53]; // SD, HD, 4K, foreign, etc.
const TV_CATS    = [62];      // TV SD, HD, 4K, foreign

/**
 * Create a fresh axios instance with a cookie jar bound to this user session.
 */
function createClient() {
  const jar = new CookieJar();
  const client = wrapper(
    axios.create({
      jar,
      withCredentials: true,
      baseURL: BASE_URL,
      timeout: 20000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "lt,en;q=0.9",
        Referer: BASE_URL + "/",
      },
    })
  );
  return { client, jar };
}

/**
 * login(username, password)
 * Returns an axios client with a valid session cookie, or throws.
 */
async function login(username, password) {
  const cacheKey = `session:${username}`;
  if (sessionCache.has(cacheKey)) {
    return sessionCache.get(cacheKey);
  }

  const { client, jar } = createClient();

  // Step 1: GET the login page to pick up any hidden tokens / cookies
  const loginPage = await client.get("/login.php");
  const $ = cheerio.load(loginPage.data);

  // Extract hidden fields from the login form (some trackers have a token)
  const formData = new URLSearchParams();
  $("form[action*='takelogin'] input[type=hidden]").each((_, el) => {
    formData.append($(el).attr("name"), $(el).attr("value") || "");
  });
  formData.append("username", username);
  formData.append("password", password);
  formData.append("keeplogged", "1");

  // Step 2: POST credentials
  const loginResp = await client.post("/takelogin.php", formData.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    maxRedirects: 5,
  });

  // Verify we are actually logged in by checking the response body
  const $after = cheerio.load(loginResp.data);
  const pageTitle = $after("title").text().toLowerCase();
  const hasLogout = loginResp.data.includes("logout") || loginResp.data.includes("atsijungti");

  if (!hasLogout && pageTitle.includes("login")) {
    throw new Error(
      "Login failed — wrong username/password or the site blocked the request."
    );
  }

  // Extract passkey from the page (used to build direct torrent download links)
  let passkey = "";
  const passkeyMatch = loginResp.data.match(/passkey=([a-f0-9]{32})/i);
  if (passkeyMatch) passkey = passkeyMatch[1];

  const session = { client, passkey, username };
  sessionCache.set(cacheKey, session);
  return session;
}

/**
 * search(session, query, type)
 * type = "movie" | "series"
 * Returns array of torrent objects.
 */
async function search(session, query, type = "movie") {
  const cacheKey = `search:${session.username}:${type}:${query}`;
  if (searchCache.has(cacheKey)) {
    return searchCache.get(cacheKey);
  }

  const cats = type === "series" ? TV_CATS : MOVIE_CATS;
  const results = [];

  // Search each relevant category (we hit browse.php once per category group,
  // using the 'c' repeated param pattern that LM supports)
  const catParams = cats.map((c) => `c${c}=1`).join("&");
  const url = `${BROWSE_URL}?search=${encodeURIComponent(query)}&${catParams}&searchin=1&incldead=0`;

  try {
    const { client } = session;
    const resp = await client.get(url);
    const parsed = parseTorrentRows(resp.data, session.passkey, type);
    results.push(...parsed);
  } catch (err) {
    console.error(`[LM] search error for "${query}":`, err.message);
  }

  searchCache.set(cacheKey, results);
  return results;
}

/**
 * parseTorrentRows(html, passkey, type)
 * Parses the browse page HTML and extracts torrent metadata.
 *
 * LM row structure (confirmed from community & Jackett definition):
 *   <tr class="torrent_...">
 *     <td>category icon</td>
 *     <td>torrent name link → /details.php?id=NNN</td>
 *     <td>size</td>
 *     <td>seeders</td>
 *     <td>leechers</td>
 *     <td>downloads</td>
 *   </tr>
 */
function parseTorrentRows(html, passkey, type) {
  const $ = cheerio.load(html);
  const torrents = [];

  // LM uses a table with class "torrenttable" or similar
  // Each torrent row has a link to /details.php?id=NNN and /download.php?id=NNN
  $("table.torrenttable tr, table tr.odd, table tr.even").each((_, row) => {
    const $row = $(row);

    // Find the torrent name/details link
    const detailsLink = $row.find('a[href*="details.php"]').first();
    if (!detailsLink.length) return;

    const href = detailsLink.attr("href") || "";
    const idMatch = href.match(/id=(\d+)/);
    if (!idMatch) return;

    const id = idMatch[1];
    const name = detailsLink.text().trim();
    if (!name) return;

    // Download link
    let downloadUrl = `${BASE_URL}/download.php?id=${id}`;
    if (passkey) downloadUrl += `&passkey=${passkey}`;

    // Size (usually 3rd or 4th td)
    const cells = $row.find("td");
    let size = "";
    let seeders = 0;
    let leechers = 0;
    let freeleech = false;

    cells.each((i, cell) => {
      const text = $(cell).text().trim();
      // Size pattern: "1.47 GB" or "700 MB"
      if (!size && /^\d+(\.\d+)?\s*(GB|MB|KB|TB)/i.test(text)) {
        size = text;
      }
    });

    // Seeders/leechers: look for green/red number cells or specific classes
    const seederCell = $row.find(".seed_count, .seeders, td.green").first();
    const leecherCell = $row.find(".leech_count, .leechers, td.red").first();
    if (seederCell.length) seeders = parseInt(seederCell.text().trim(), 10) || 0;
    if (leecherCell.length) leechers = parseInt(leecherCell.text().trim(), 10) || 0;

    // Freeleech badge
    freeleech =
      $row.find(".freeleech, .fl").length > 0 ||
      $row.html().toLowerCase().includes("freeleech");

    // Quality detection from name
    const quality = detectQuality(name);

    torrents.push({
      id,
      name,
      downloadUrl,
      size,
      seeders,
      leechers,
      freeleech,
      quality,
      infoHash: null, // LM doesn't expose infohash on browse page
    });
  });

  return torrents;
}

/**
 * detectQuality(name)
 * Returns a human-readable quality label parsed from the torrent name.
 */
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

/**
 * invalidateSession(username)
 * Call this when a search fails due to auth errors, to force re-login.
 */
function invalidateSession(username) {
  sessionCache.del(`session:${username}`);
}

module.exports = { login, search, invalidateSession };
