import * as cheerio from "cheerio";
import { sha256, getDiscoveryCache, setDiscoveryCache } from "./storage.js";
import { analyzeQuery, relevanceScore } from "./intent.js";

const DISCOVERY_UA = "Mozilla/5.0 (compatible; AAUWebSearch/0.4.2; +https://web-search-api-m30a.onrender.com)";
const DISCOVERY_CACHE_VERSION = 2;
let nextAllowedAt = 0;

async function throttle(ms = 850) {
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
    if (u.hostname.endsWith("bing.com") && /\/news\/apiclick\.aspx$/i.test(u.pathname) && u.searchParams.get("url")) {
      return decodeURIComponent(u.searchParams.get("url"));
    }
    if (u.hostname.endsWith("bing.com") && /\/ck\/a$/i.test(u.pathname) && u.searchParams.get("u")) {
      const encoded = u.searchParams.get("u");
      try {
        const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
        const decoded = Buffer.from(payload, "base64url").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {}
    }
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeRows(rows, provider) {
  return rows.map((row, index) => ({
    title: row.title || null,
    url: normalizeResultUrl(row.url),
    snippet: row.snippet || null,
    publishedAt: row.publishedAt || null,
    provider,
    rank: index + 1
  })).filter((row) => row.url);
}

function fuse(rows, analysis, limit) {
  const byUrl = new Map();

  for (const row of rows) {
    const current = byUrl.get(row.url);
    const scored = {
      ...row,
      relevance: relevanceScore(row, analysis)
    };

    if (!current || scored.relevance > current.relevance) {
      byUrl.set(row.url, scored);
    }
  }

  let ranked = [...byUrl.values()]
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return (a.rank || 99) - (b.rank || 99);
    });

  if (analysis.intent.startsWith("technical")) {
    const relevant = ranked.filter((row) => row.relevance >= 0);
    if (relevant.length) ranked = relevant;
  }

  ranked = ranked
    .slice(0, limit)
    .map((row, index) => ({
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      publishedAt: row.publishedAt,
      provider: row.provider,
      rank: index + 1,
      relevance: Number(row.relevance.toFixed(3))
    }));

  return ranked;
}

async function discoverSearx(query, limit, category = "general") {
  const base = process.env.SEARCH_DISCOVERY_BASE_URL?.trim();
  if (!base) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", category);
  url.searchParams.set("language", "en");

  const response = await fetch(url, {
    headers: { "user-agent": DISCOVERY_UA, accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`searx_${response.status}`);

  const json = await response.json();
  return normalizeRows(
    (json?.results || []).slice(0, limit).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content,
      publishedAt: x.publishedDate || x.published_date || null
    })),
    category === "news" ? "searxng-news" : "searxng"
  );
}

async function discoverBingNews(query, limit) {
  await throttle();
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("count", "20");

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`bing_news_${response.status}`);

  const xml = await response.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const rows = [];
  $("item").each((_, item) => {
    rows.push({
      title: $(item).find("title").first().text().trim(),
      url: $(item).find("link").first().text().trim(),
      snippet: $(item).find("description").first().text().trim(),
      publishedAt: $(item).find("pubDate").first().text().trim() || null
    });
  });

  return normalizeRows(rows.slice(0, Math.max(limit, 20)), "bing-news-rss");
}

async function discoverBingHtml(query, limit) {
  await throttle();
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`bing_html_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];
  $("li.b_algo").each((_, item) => {
    const link = $(item).find("h2 a").first();
    rows.push({
      title: link.text().trim(),
      url: link.attr("href"),
      snippet: $(item).find(".b_caption p").first().text().trim() || $(item).find("p").first().text().trim()
    });
  });

  return normalizeRows(rows.slice(0, Math.max(limit, 20)), "bing-html");
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
      snippet: $(result).find(".result__snippet").first().text().trim()
    });
  });

  return normalizeRows(rows.slice(0, limit), "duckduckgo-html");
}

async function runVariant(query, analysis, limit) {
  const attempts = [];
  const rows = [];

  if (process.env.SEARCH_DISCOVERY_BASE_URL) {
    try {
      const category = analysis.intent === "news" ? "news" : "general";
      const found = await discoverSearx(query, limit, category);
      rows.push(...found);
      attempts.push({ provider: category === "news" ? "searxng-news" : "searxng", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "searxng", query, ok: false, error: error?.message });
    }
  }

  if (analysis.intent === "news") {
    try {
      const found = await discoverBingNews(query, limit);
      rows.push(...found);
      attempts.push({ provider: "bing-news-rss", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "bing-news-rss", query, ok: false, error: error?.message });
    }
  } else {
    try {
      const found = await discoverBingHtml(query, limit);
      rows.push(...found);
      attempts.push({ provider: "bing-html", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "bing-html", query, ok: false, error: error?.message });
    }
  }

  if (!rows.length || analysis.intent.startsWith("technical")) {
    try {
      const found = await discoverDuckDuckGo(query, limit);
      rows.push(...found);
      attempts.push({ provider: "duckduckgo-html", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "duckduckgo-html", query, ok: false, error: error?.message });
    }
  }

  return { rows, attempts };
}

export async function discoverWeb(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query_required");

  const limit = Math.max(1, Math.min(Number(options.limit || 8), 20));
  const cacheTtl = Math.max(30, Math.min(Number(options.cacheTtl || 600), 3600));
  const analysis = analyzeQuery(q);

  const cacheKey = sha256(JSON.stringify({
    cacheVersion: DISCOVERY_CACHE_VERSION,
    q: q.toLowerCase(),
    limit,
    intent: analysis.intent,
    variants: analysis.variants,
    provider: process.env.SEARCH_DISCOVERY_BASE_URL ? "searxng+bing" : "bing"
  }));

  const cached = await getDiscoveryCache(cacheKey).catch(() => null);
  if (cached) {
    return { ...cached, cached: true };
  }

  const attempts = [];
  const collected = [];

  for (const variant of analysis.variants) {
    const result = await runVariant(variant, analysis, Math.max(limit, 10));
    attempts.push(...result.attempts);
    collected.push(...result.rows);

    const early = fuse(collected, analysis, limit);
    if (early.length >= limit && early[0]?.relevance >= 4 && variant !== q) break;
  }

  const results = fuse(collected, analysis, limit);

  const value = {
    query: q,
    intent: analysis.intent,
    anchors: analysis.anchors,
    effectiveQueries: analysis.variants,
    results,
    provider: results[0]?.provider || null,
    attempts,
    cached: false,
    discoveredAt: new Date().toISOString()
  };

  await setDiscoveryCache(cacheKey, value, cacheTtl).catch(() => {});
  return value;
}
