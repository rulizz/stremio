/**
 * linkomanija.js — scraper + session manager
 * Selectors confirmed from live HTML debug:
 *
 * <tr class="torrenttable">
 *   td[0] = category icon
 *   td[1] = torrent name + download link + bookmark
 *   td[2] = file count
 *   td[3] = comments
 *   td[4] = date
 *   td[5] = size (has <br> between number and unit e.g. "2.45<br>GB")
 *   td[6] = downloads count
 *   td[7] = seeders (in <span class="slrN">)
 *   td[8] = leechers
 *
 * Name link: href="details?ID.Title_With_Underscores"
 * Download:  href="download.php?id=ID&name=File.Name.torrent"
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
    body.includes("Atsijungti");

  if (!hasLogout) {
    const snippet = body.substring(0, 500).replace(/\s+/g, " ");
    console.error("[LOGIN FAIL] Page snippet:", snippet);
    throw new Error("Login failed — check credentials.");
  }

  // Extract passkey from page (used in download URLs)
  let passkey = "";
  const passkeyMatch = body.match(/passkey=([a-f0-9]{32,40})/i);
  if (passkeyMatch) {
    passkey = passkeyMatch[1];
    console.log("[LOGIN] Passkey found:", passkey.substring(0, 8) + "...");
  } else {
    console.warn("[LOGIN] No passkey found in page HTML");
  }

  console.log("[LOGIN] Success for:", username);
  const session = { client, passkey, username };
  sessionCache.set(cacheKey, session);
  return session;
}

// ── Search ────────────────────────────────────────────────────────────────────
// Score how well a torrent name matches the search query.
// Returns 0 if it's clearly irrelevant, higher = better match.
function relevanceScore(torrentName, query) {
  const name = torrentName.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const q    = query.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();

  const nameWords  = name.split(" ");
  const queryWords = q.split(" ");

  // All query words must appear in the torrent name
  const allMatch = queryWords.every(w => nameWords.includes(w));
  if (!allMatch) return 0;

  // Penalize if torrent name has extra "story" words suggesting a different entry
  // e.g. query="toy story 2" should not match "toy story 1" or "toy story 3"
  // Check if there's a number in the query — if so, the torrent must have the same number
  const queryNums = queryWords.filter(w => /^\d+$/.test(w));
  if (queryNums.length > 0) {
    const nameNums = nameWords.filter(w => /^\d+$/.test(w));
    // torrent must contain all query numbers
    const hasAllNums = queryNums.every(n => nameNums.includes(n));
    if (!hasAllNums) return 0;
  }

  // Bonus: torrent name starts with the query words (very strong match)
  const startsWithQuery = name.startsWith(q);
  const lengthPenalty = Math.max(0, nameWords.length - queryWords.length); // fewer extra words = better

  return 100 + (startsWithQuery ? 50 : 0) - lengthPenalty;
}

async function search(session, query, type = "movie", cats = [61, 53]) {
  const cacheKey = `search:${session.username}:${type}:${query}:${cats.join(",")}`;
  if (searchCache.has(cacheKey)) {
    console.log(`[SEARCH] Cache hit: "${query}"`);
    return searchCache.get(cacheKey);
  }

  // LM supports multi-category in one request using c{ID}=1 format
  // e.g. browse.php?c53=1&c61=1&search=...
  const catParams = cats.map(c => "c" + c + "=1").join("&");
  const url = `${BROWSE_URL}?${catParams}&search=${encodeURIComponent(query)}&searchin=1&incldead=0`;
  console.log(`[SEARCH] ${url}`);

  let allResults = [];
  try {
    const resp = await session.client.get(url);
    allResults = parseTorrentRows(resp.data, session.passkey);
    console.log(`[SEARCH] ${allResults.length} rows from single request`);
  } catch (err) {
    console.error("[SEARCH] error:", err.message);
  }

  // Filter by relevance — only keep results that actually match the query
  const scored = allResults
    .map(t => ({ t, score: relevanceScore(t.name, query) }))
    .filter(x => x.score > 0);

  console.log(`[SEARCH] ${allResults.length} total → ${scored.length} relevant for "${query}"`);

  // Return sorted by relevance score (buildStreams will re-sort by user prefs)
  const results = scored.sort((a, b) => b.score - a.score).map(x => x.t);

  searchCache.set(cacheKey, results);
  return results;
}

// ── Debug ─────────────────────────────────────────────────────────────────────
async function debugSearch(session, query, cats) {
  // Categories: 61 = Movies LT, 53 = Movies EN (verified working)
  const catParams = (cats || [61,53]).map(c => "c" + c + "=1").join("&");
  const url = `${BROWSE_URL}?${catParams}&search=${encodeURIComponent(query)}&searchin=1&incldead=0`;
  const resp = await session.client.get(url);
  return { html: resp.data, url };
}

// ── Parser — confirmed against live HTML ──────────────────────────────────────
function parseTorrentRows(html, passkey) {
  const $ = cheerio.load(html);
  const torrents = [];

  $("tr.torrenttable").each((_, row) => {
    const $row = $(row);
    const cells = $row.find("td");
    if (cells.length < 9) return; // need all 9 columns

    // ── td[1]: name + download link ──────────────────────────────────────────
    const $nameCell = cells.eq(1);

    // Torrent name: the <b> tag inside the first <a> in td[1]
    const name = $nameCell.find("a b").first().text().trim() ||
                 $nameCell.find("a").first().text().trim();
    if (!name || name.length < 3) return;

    // Download link: <a href="download.php?id=...&name=...">
    const $dlLink = $nameCell.find('a[href*="download.php"]').first();
    if (!$dlLink.length) return;

    const dlHref = $dlLink.attr("href") || "";
    const idMatch = dlHref.match(/[?&]id=(\d+)/);
    if (!idMatch) return;

    const id = idMatch[1];

    // Build full download URL — keep the original href (it has the &name= param)
    let downloadUrl = dlHref.startsWith("http")
      ? dlHref
      : BASE_URL + "/" + dlHref.replace(/^\//, "");

    // Append passkey if we have one and it's not already there
    if (passkey && !downloadUrl.includes("passkey=")) {
      downloadUrl += `&passkey=${passkey}`;
    }

    // ── td[5]: size ──────────────────────────────────────────────────────────
    // LM has "2.45<br>GB" so .text() gives "2.45GB" — clean it up
    const rawSize = cells.eq(5).text().trim().replace(/\s+/g, "");
    const size = rawSize.replace(/(\d)(GB|MB|KB|TB)/i, "$1 $2"); // "2.45 GB"

    // ── td[7]: seeders (inside <span class="slrN">) ──────────────────────────
    const seeders = parseInt(
      cells.eq(7).text().trim().replace(/[,\s]/g, ""), 10
    ) || 0;

    // ── td[8]: leechers ──────────────────────────────────────────────────────
    const leechers = parseInt(
      cells.eq(8).text().trim().replace(/[,\s]/g, ""), 10
    ) || 0;

    // ── Freeleech detection ───────────────────────────────────────────────────
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
  return torrents.filter(t => {
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
