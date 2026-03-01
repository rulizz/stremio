/**
 * linkomanija.js — scraper + session manager
 */

const axios = require("axios");
const cheerio = require("cheerio");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const NodeCache = require("node-cache");

const BASE_URL = "https://www.linkomanija.net";
const BROWSE_URL = `${BASE_URL}/browse.php`;

const sessionCache = new NodeCache({ stdTTL: 28800, checkperiod: 600 });
const searchCache = new NodeCache({ stdTTL: 900, checkperiod: 120 });

const MOVIE_CATS = [1, 2, 3, 22, 23, 42];
const TV_CATS    = [7, 8, 9, 24, 25];

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
  return { client, jar };
}

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

  let passkey = "";
  const passkeyMatch = body.match(/passkey=([a-f0-9]{32,40})/i);
  if (passkeyMatch) {
    passkey = passkeyMatch[1];
    console.log("[LOGIN] Passkey found:", passkey.substring(0, 8) + "...");
  } else {
    console.warn("[LOGIN] No passkey found in page");
  }

  console.log("[LOGIN] Success for:", username);
  const session = { client, passkey, username };
  sessionCache.set(cacheKey, session);
  return session;
}

async function search(session, query, type = "movie") {
  const cacheKey = `search:${session.username}:${type}:${query}`;
  if (searchCache.has(cacheKey)) {
    console.log(`[SEARCH] Cache hit for "${query}"`);
    return searchCache.get(cacheKey);
  }

  const cats = type === "series" ? TV_CATS : MOVIE_CATS;
  const catParams = cats.map((c) => `c${c}=1`).join("&");
  const url = `${BROWSE_URL}?search=${encodeURIComponent(query)}&${catParams}&searchin=1&incldead=0`;

  console.log(`[SEARCH] Fetching: ${url}`);

  let html = "";
  try {
    const resp = await session.client.get(url);
    html = resp.data;
    console.log(`[SEARCH] Got ${html.length} bytes of HTML`);
  } catch (err) {
    console.error(`[SEARCH] HTTP error:`, err.message);
    return [];
  }

  const results = parseTorrentRows(html, session.passkey);
  console.log(`[SEARCH] Parsed ${results.length} torrents for "${query}"`);
  searchCache.set(cacheKey, results);
  return results;
}

async function debugSearch(session, query, type = "movie") {
  const cats = type === "series" ? TV_CATS : MOVIE_CATS;
  const catParams = cats.map((c) => `c${c}=1`).join("&");
  const url = `${BROWSE_URL}?search=${encodeURIComponent(query)}&${catParams}&searchin=1&incldead=0`;
  const resp = await session.client.get(url);
  return { html: resp.data, url };
}

function parseTorrentRows(html, passkey) {
  const $ = cheerio.load(html);
  const torrents = [];

  // Find ALL detail links — works regardless of table structure
  const detailLinks = $('a[href*="details.php?id="]');
  console.log(`[PARSE] Found ${detailLinks.length} detail links`);

  detailLinks.each((_, link) => {
    const $link = $(link);
    const href = $link.attr("href") || "";
    const idMatch = href.match(/[?&]id=(\d+)/);
    if (!idMatch) return;

    const id = idMatch[1];
    const name = $link.text().trim();
    if (!name || name.length < 3) return;

    const $row = $link.closest("tr");
    if (!$row.length) return;

    let downloadUrl = `${BASE_URL}/download.php?id=${id}`;
    if (passkey) downloadUrl += `&passkey=${passkey}`;

    const $dlLink = $row.find('a[href*="download.php"]').first();
    if ($dlLink.length) {
      const dlHref = $dlLink.attr("href") || "";
      downloadUrl = dlHref.startsWith("http") ? dlHref : BASE_URL + (dlHref.startsWith("/") ? dlHref : "/" + dlHref);
    }

    const cells = $row.find("td");
    let size = "";
    let seeders = 0;
    let leechers = 0;

    cells.each((i, cell) => {
      const $cell = $(cell);
      const text = $cell.text().trim();

      if (!size && /^[\d.,]+\s*(GB|MB|KB|TB)/i.test(text)) {
        size = text;
      }

      const cls = ($cell.attr("class") || "").toLowerCase();
      if (cls.includes("seed") || cls.includes("green")) {
        const n = parseInt(text, 10);
        if (!isNaN(n) && seeders === 0) seeders = n;
      }
      if (cls.includes("leech") || cls.includes("red")) {
        const n = parseInt(text, 10);
        if (!isNaN(n) && leechers === 0) leechers = n;
      }
    });

    const rowHtml = ($row.html() || "").toLowerCase();
    const freeleech =
      rowHtml.includes("freeleech") ||
      $row.find(".freeleech, .fl, [class*='free']").length > 0;

    torrents.push({
      id, name, downloadUrl, size, seeders, leechers,
      freeleech, quality: detectQuality(name),
    });
  });

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
