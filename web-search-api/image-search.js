import * as cheerio from "cheerio";
import { sha256, getDiscoveryCache, setDiscoveryCache } from "./storage.js";
import { buildRightsMetadata } from "./media-rights.js";

const IMAGE_SEARCH_UA =
  "Mozilla/5.0 (compatible; CrawlerImageSearch/0.8; +https://web-search-api-m30a.onrender.com)";
const IMAGE_CACHE_VERSION = 2;
const providerNextAllowedAt = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value, max = 2000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function clampInt(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol)) return null;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function normalizeDomain(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split(":")[0];
}

function hostMatches(urlValue, domains = []) {
  if (!domains.length) return true;
  try {
    const host = new URL(urlValue).hostname.toLowerCase().replace(/^www\./, "");
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
  } catch {
    return false;
  }
}

function normalizeSafeSearch(value) {
  const normalized = String(value || "moderate").trim().toLowerCase();
  if (["strict", "moderate", "off"].includes(normalized)) return normalized;
  return "moderate";
}

function normalizeAspect(value) {
  const normalized = String(value || "any").trim().toLowerCase();
  if (["any", "square", "wide", "tall"].includes(normalized)) return normalized;
  return "any";
}

const IMAGE_QUERY_STOP_WORDS = new Set([
  "a","an","and","at","by","for","from","in","of","on","or","the","to","with",
  "image","images","photo","photos","picture","pictures"
]);

function imageQueryTokens(query) {
  return clean(query, 1000)
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !IMAGE_QUERY_STOP_WORDS.has(token));
}

function imageRelevance(row, query) {
  const tokens = imageQueryTokens(query);
  if (!tokens.length) return { matched: true, score: 1, matches: 0 };

  const hay = [
    row?.title,
    row?.source_url,
    row?.creator
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  let matches = 0;
  for (const token of tokens) {
    if (hay.includes(token)) matches += 1;
  }

  const required = tokens.length >= 3 ? 2 : 1;
  const phrase = clean(query, 1000).toLowerCase();
  const phraseBonus = phrase && hay.includes(phrase) ? 1 : 0;
  const score = (matches / tokens.length) + phraseBonus;

  return {
    matched: matches >= required,
    score,
    matches
  };
}

function aspectMatches(width, height, aspect) {
  if (aspect === "any") return true;
  if (!(width > 0 && height > 0)) return false;
  const ratio = width / height;
  if (aspect === "square") return ratio >= 0.8 && ratio <= 1.25;
  if (aspect === "wide") return ratio >= 1.3;
  if (aspect === "tall") return ratio <= 0.77;
  return true;
}

async function throttle(provider, ms = 450) {
  const now = Date.now();
  const reservedAt = Math.max(now, providerNextAllowedAt.get(provider) || 0);
  providerNextAllowedAt.set(provider, reservedAt + ms);
  const wait = reservedAt - now;
  if (wait > 0) await sleep(wait);
}

function normalizedImageRow(row, provider, rank) {
  const imageUrl = normalizeUrl(row.image_url || row.imageUrl || row.img_src || row.murl);
  const sourceUrl = normalizeUrl(row.source_url || row.sourceUrl || row.url || row.purl);
  if (!imageUrl || !sourceUrl) return null;

  const thumbnailUrl = normalizeUrl(
    row.thumbnail_url || row.thumbnailUrl || row.thumbnail_src || row.turl
  );
  const width = clampInt(row.width || row.imgWidth, 0, 0, 20000) || null;
  const height = clampInt(row.height || row.imgHeight, 0, 0, 20000) || null;

  const rights = buildRightsMetadata({
    license: row.license,
    license_url: row.license_url || row.licenseUrl,
    creator: row.creator || row.author,
    creator_url: row.creator_url || row.creatorUrl,
    copyright_notice: row.copyright_notice || row.copyright,
    attribution_text: row.attribution_text,
    attribution_required: row.attribution_required
  });

  return {
    title: clean(row.title || row.name || row.t || row.desc, 500) || null,
    image_url: imageUrl,
    thumbnail_url: thumbnailUrl,
    source_url: sourceUrl,
    width,
    height,
    provider,
    rank,
    license: rights.license,
    license_url: rights.license_url,
    copyright_status: rights.copyright_status,
    copyright_notice: rights.copyright_notice,
    creator: rights.creator,
    creator_url: rights.creator_url,
    attribution_required: rights.attribution_required,
    attribution_text: rights.attribution_text,
    rights
  };
}

async function discoverSearxImages(query, { limit, safeSearch }) {
  const base = process.env.SEARCH_DISCOVERY_BASE_URL?.trim();
  if (!base) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "images");
  url.searchParams.set("language", "en");
  url.searchParams.set(
    "safesearch",
    safeSearch === "strict" ? "2" : safeSearch === "off" ? "0" : "1"
  );

  const response = await fetch(url, {
    headers: {
      "user-agent": IMAGE_SEARCH_UA,
      accept: "application/json"
    },
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`searx_images_${response.status}`);

  const json = await response.json();
  return (json?.results || [])
    .slice(0, Math.max(limit * 3, 20))
    .map((row, index) =>
      normalizedImageRow(
        {
          title: row.title,
          image_url: row.img_src || row.image_src,
          thumbnail_url: row.thumbnail_src || row.thumbnail,
          source_url: row.url || row.source_url,
          width: row.width,
          height: row.height,
          license: row.license,
          license_url: row.license_url || row.licenseUrl,
          creator: row.author || row.creator,
          creator_url: row.creator_url || row.author_url,
          copyright_notice: row.copyright || row.copyright_notice,
          attribution_text: row.attribution_text,
          attribution_required: row.attribution_required
        },
        "searxng-images",
        index + 1
      )
    )
    .filter(Boolean);
}

function parseBingMetadata(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    try {
      return JSON.parse(
        String(raw)
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, "&")
          .replace(/&#39;/g, "'")
      );
    } catch {
      return null;
    }
  }
}

async function discoverBingImages(query, { limit, safeSearch }) {
  await throttle("bing-images", 500);

  const url = new URL("https://www.bing.com/images/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(Math.max(limit * 4, 24), 100)));
  url.searchParams.set("first", "1");
  url.searchParams.set(
    "adlt",
    safeSearch === "strict" ? "strict" : safeSearch === "off" ? "off" : "moderate"
  );

  const response = await fetch(url, {
    headers: {
      "user-agent": IMAGE_SEARCH_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.8"
    },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error(`bing_images_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];

  $("a.iusc").each((_, element) => {
    const node = $(element);
    const metadata = parseBingMetadata(node.attr("m") || node.attr("data-m"));
    if (!metadata) return;

    const normalized = normalizedImageRow(
      {
        title:
          metadata.t ||
          metadata.desc ||
          node.attr("aria-label") ||
          node.find("img").attr("alt"),
        murl: metadata.murl,
        turl: metadata.turl,
        purl: metadata.purl,
        imgWidth: metadata.imgWidth || metadata.w,
        imgHeight: metadata.imgHeight || metadata.h,
        creator: metadata.creator || metadata.author,
        creator_url: metadata.creatorUrl || metadata.authorUrl,
        license: metadata.license,
        license_url: metadata.licenseUrl,
        copyright_notice: metadata.copyright || metadata.copyrightNotice,
        attribution_text: metadata.attributionText,
        attribution_required: metadata.attributionRequired
      },
      "bing-images-html",
      rows.length + 1
    );

    if (normalized) rows.push(normalized);
  });

  return rows.slice(0, Math.max(limit * 3, 24));
}

function fuseImageRows(rows, options, query) {
  const preferredDomains = (options.preferredDomains || [])
    .map(normalizeDomain)
    .filter(Boolean);
  const excludedDomains = (options.excludedDomains || [])
    .map(normalizeDomain)
    .filter(Boolean);

  const seen = new Set();
  const filtered = [];

  for (const row of rows) {
    if (!row?.image_url || !row?.source_url) continue;
    if (seen.has(row.image_url)) continue;
    seen.add(row.image_url);

    if (preferredDomains.length && !hostMatches(row.source_url, preferredDomains)) continue;
    if (excludedDomains.length && hostMatches(row.source_url, excludedDomains)) continue;
    if ((row.width || 0) < options.minWidth) continue;
    if ((row.height || 0) < options.minHeight) continue;
    if (!aspectMatches(row.width, row.height, options.aspect)) continue;

    const relevance = imageRelevance(row, query);
    if (!relevance.matched) continue;

    filtered.push({
      ...row,
      relevance_score: Number(relevance.score.toFixed(4)),
      relevance_matches: relevance.matches
    });
  }

  filtered.sort((a, b) =>
    (b.relevance_score || 0) - (a.relevance_score || 0) ||
    (a.rank || 0) - (b.rank || 0)
  );

  return filtered.slice(0, options.limit).map((row, index) => ({
    ...row,
    rank: index + 1
  }));
}

export async function searchImages(query, options = {}) {
  const q = clean(query, 1000);
  if (!q) throw new Error("query_required");

  const normalized = {
    limit: clampInt(options.limit || options.maxResults, 12, 1, 30),
    safeSearch: normalizeSafeSearch(options.safeSearch || options.safe_search),
    aspect: normalizeAspect(options.aspect),
    minWidth: clampInt(options.minWidth || options.min_width, 0, 0, 10000),
    minHeight: clampInt(options.minHeight || options.min_height, 0, 0, 10000),
    preferredDomains: Array.isArray(options.preferredDomains || options.preferred_domains)
      ? (options.preferredDomains || options.preferred_domains).slice(0, 12)
      : [],
    excludedDomains: Array.isArray(options.excludedDomains || options.excluded_domains)
      ? (options.excludedDomains || options.excluded_domains).slice(0, 12)
      : [],
    cacheTtl: clampInt(options.cacheTtl || options.cache_ttl, 1800, 30, 21600)
  };

  const providerSet = process.env.SEARCH_DISCOVERY_BASE_URL
    ? "searxng-images+bing-images"
    : "bing-images";

  const cacheKey = sha256(JSON.stringify({
    cacheVersion: IMAGE_CACHE_VERSION,
    query: q.toLowerCase(),
    ...normalized,
    providerSet
  }));

  try {
    const cached = await Promise.race([
      getDiscoveryCache(cacheKey),
      new Promise((resolve) => setTimeout(() => resolve(null), 500))
    ]);
    if (cached) return { ...cached, cached: true };
  } catch {}

  const attempts = [];
  const jobs = [];

  if (process.env.SEARCH_DISCOVERY_BASE_URL) {
    jobs.push(
      discoverSearxImages(q, normalized)
        .then((rows) => ({ provider: "searxng-images", rows }))
        .catch((error) => ({ provider: "searxng-images", rows: [], error: error?.message }))
    );
  }

  jobs.push(
    discoverBingImages(q, normalized)
      .then((rows) => ({ provider: "bing-images-html", rows }))
      .catch((error) => ({ provider: "bing-images-html", rows: [], error: error?.message }))
  );

  const settled = await Promise.all(jobs);
  const allRows = [];

  for (const item of settled) {
    attempts.push({
      provider: item.provider,
      ok: item.rows.length > 0,
      resultCount: item.rows.length,
      ...(item.error ? { error: item.error } : {})
    });
    allRows.push(...item.rows);
  }

  const results = fuseImageRows(allRows, normalized, q);
  const value = {
    query: q,
    results,
    provider: results[0]?.provider || null,
    providers: [...new Set(results.map((row) => row.provider))],
    attempts,
    cached: false,
    searchedAt: new Date().toISOString(),
    filters: {
      safe_search: normalized.safeSearch,
      aspect: normalized.aspect,
      min_width: normalized.minWidth,
      min_height: normalized.minHeight,
      preferred_domains: normalized.preferredDomains,
      excluded_domains: normalized.excludedDomains
    },
    rights_notice:
      "Image discovery returns upstream rights metadata when explicitly available, but does not grant reuse rights. rights_verified=false means the caller must verify license, attribution, and copyright on source_url before reuse or redistribution."
  };

  void setDiscoveryCache(cacheKey, value, normalized.cacheTtl).catch(() => {});
  return value;
}
