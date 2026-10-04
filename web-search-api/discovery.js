import * as cheerio from "cheerio";
import { sha256, getDiscoveryCache, setDiscoveryCache } from "./storage.js";

const DISCOVERY_UA = "Mozilla/5.0 (compatible; AAUWebSearch/0.3; +https://web-search-api-m30a.onrender.com)";
let nextAllowedAt = 0;

async function throttle(ms = 900) {
  const wait = Math.max(0, nextAllowedAt - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextAllowedAt = Date.now() + ms;
}

function normalizeResultUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.get("uddg")) {
      return decodeURIComponent(u.searchParams.get("uddg"));
    }
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function dedupe(results, limit) {
  const seen = new Set();
  const out = [];
  for (const row of results) {
    const url = normalizeResultUrl(row.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      title: row.title || null,
      url,
      snippet: row.snippet || null,
      provider: row.provider || null,
      rank: out.length + 1
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function discoverSearx(query, limit) {
  const base = process.env.SEARCH_DISCOVERY_BASE_URL?.trim();
  if (!base) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "general");
  url.searchParams.set("language", "en");

  const response = await fetch(url, {
    headers: { "user-agent": DISCOVERY_UA, accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`searx_${response.status}`);

  const json = await response.json();
  return dedupe(
    (json?.results || []).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content,
      provider: "searxng"
    })),
    limit
  );
}

async function discoverBingRss(query, limit) {
  await throttle();
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("count", String(Math.min(20, Math.max(limit, 10))));

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`bing_${response.status}`);

  const xml = await response.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const rows = [];
  $("item").each((_, item) => {
    rows.push({
      title: $(item).find("title").first().text().trim(),
      url: $(item).find("link").first().text().trim(),
      snippet: $(item).find("description").first().text().trim(),
      provider: "bing-rss"
    });
  });
  return dedupe(rows, limit);
}

async function discoverDuckDuckGo(query, limit) {
  await throttle();
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`ddg_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];
  $(".result").each((_, result) => {
    const link = $(result).find(".result__a").first();
    rows.push({
      title: link.text().trim(),
      url: link.attr("href"),
      snippet: $(result).find(".result__snippet").first().text().trim(),
      provider: "duckduckgo-html"
    });
  });
  return dedupe(rows, limit);
}

export async function discoverWeb(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query_required");

  const limit = Math.max(1, Math.min(Number(options.limit || 8), 20));
  const cacheTtl = Math.max(30, Math.min(Number(options.cacheTtl || 600), 3600));
  const cacheKey = sha256(JSON.stringify({
    q: q.toLowerCase(),
    limit,
    provider: process.env.SEARCH_DISCOVERY_BASE_URL ? "searxng" : "auto"
  }));

  const cached = await getDiscoveryCache(cacheKey).catch(() => null);
  if (cached) {
    return {
      ...cached,
      cached: true
    };
  }

  const attempts = [];
  let results = [];

  if (process.env.SEARCH_DISCOVERY_BASE_URL) {
    try {
      results = await discoverSearx(q, limit);
      attempts.push({ provider: "searxng", ok: results.length > 0 });
    } catch (error) {
      attempts.push({ provider: "searxng", ok: false, error: error?.message });
    }
  }

  if (!results.length) {
    try {
      results = await discoverBingRss(q, limit);
      attempts.push({ provider: "bing-rss", ok: results.length > 0 });
    } catch (error) {
      attempts.push({ provider: "bing-rss", ok: false, error: error?.message });
    }
  }

  if (!results.length) {
    try {
      results = await discoverDuckDuckGo(q, limit);
      attempts.push({ provider: "duckduckgo-html", ok: results.length > 0 });
    } catch (error) {
      attempts.push({ provider: "duckduckgo-html", ok: false, error: error?.message });
    }
  }

  const value = {
    query: q,
    results,
    provider: results[0]?.provider || null,
    attempts,
    cached: false,
    discoveredAt: new Date().toISOString()
  };

  await setDiscoveryCache(cacheKey, value, cacheTtl).catch(() => {});
  return value;
}
