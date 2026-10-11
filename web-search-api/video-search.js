import { sha256, getDiscoveryCache, setDiscoveryCache } from "./storage.js";
import { buildRightsMetadata } from "./media-rights.js";

const VIDEO_SEARCH_UA =
  "Mozilla/5.0 (compatible; CrawlerVideoSearch/0.8; +https://web-search-api-m30a.onrender.com)";
const VIDEO_CACHE_VERSION = 1;

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

function simpleText(node) {
  if (!node) return "";
  if (typeof node.simpleText === "string") return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((run) => run?.text || "").join("");
  return "";
}

function parseDurationSeconds(value) {
  const text = clean(value, 40);
  if (!/^\d{1,3}(?::\d{1,2}){1,2}$/.test(text)) return null;
  const parts = text.split(":").map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds;
}

function extractJsonAfterMarker(text, marker) {
  const startMarker = text.indexOf(marker);
  if (startMarker < 0) return null;
  const start = text.indexOf("{", startMarker + marker.length);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function collectVideoRenderers(root, limit) {
  const found = [];
  const stack = [root];
  while (stack.length && found.length < limit) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    if (node.videoRenderer && typeof node.videoRenderer === "object") {
      found.push(node.videoRenderer);
      if (found.length >= limit) break;
    }

    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) stack.push(node[i]);
    } else {
      for (const value of Object.values(node)) stack.push(value);
    }
  }
  return found;
}

function normalizeVideoRow(row, provider, rank) {
  const videoUrl = normalizeUrl(row.video_url || row.videoUrl || row.url);
  if (!videoUrl) return null;

  const sourceUrl = normalizeUrl(row.source_url || row.sourceUrl || videoUrl) || videoUrl;
  const thumbnailUrl = normalizeUrl(row.thumbnail_url || row.thumbnailUrl || row.thumbnail);
  const creator = clean(row.creator || row.author, 300) || null;
  const creatorUrl = normalizeUrl(row.creator_url || row.creatorUrl || row.author_url);

  const rights = buildRightsMetadata({
    license: row.license,
    license_url: row.license_url || row.licenseUrl,
    creator,
    creator_url: creatorUrl,
    copyright_notice: row.copyright_notice || row.copyright,
    attribution_text: row.attribution_text,
    attribution_required: row.attribution_required
  });

  return {
    title: clean(row.title, 500) || null,
    video_url: videoUrl,
    source_url: sourceUrl,
    thumbnail_url: thumbnailUrl,
    creator,
    creator_url: creatorUrl,
    duration_seconds:
      Number.isFinite(Number(row.duration_seconds))
        ? Number(row.duration_seconds)
        : parseDurationSeconds(row.duration),
    published_text: clean(row.published_text || row.publishedAt, 200) || null,
    views_text: clean(row.views_text || row.views, 200) || null,
    provider,
    rank,
    license: rights.license,
    license_url: rights.license_url,
    copyright_status: rights.copyright_status,
    copyright_notice: rights.copyright_notice,
    attribution_required: rights.attribution_required,
    attribution_text: rights.attribution_text,
    rights
  };
}

async function discoverSearxVideos(query, { limit, safeSearch }) {
  const base = process.env.SEARCH_DISCOVERY_BASE_URL?.trim();
  if (!base) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", "videos");
  url.searchParams.set("language", "en");
  url.searchParams.set(
    "safesearch",
    safeSearch === "strict" ? "2" : safeSearch === "off" ? "0" : "1"
  );

  const response = await fetch(url, {
    headers: { "user-agent": VIDEO_SEARCH_UA, accept: "application/json" },
    signal: AbortSignal.timeout(5500)
  });
  if (!response.ok) throw new Error(`searx_videos_${response.status}`);

  const json = await response.json();
  return (json?.results || [])
    .slice(0, Math.max(limit * 3, 20))
    .map((row, index) =>
      normalizeVideoRow(
        {
          title: row.title,
          video_url: row.url,
          source_url: row.url,
          thumbnail_url: row.thumbnail || row.thumbnail_src,
          creator: row.author || row.creator,
          creator_url: row.author_url || row.creator_url,
          duration: row.length || row.duration,
          published_text: row.publishedDate || row.published_date,
          views_text: row.views,
          license: row.license,
          license_url: row.license_url || row.licenseUrl,
          copyright_notice: row.copyright || row.copyright_notice,
          attribution_text: row.attribution_text,
          attribution_required: row.attribution_required
        },
        "searxng-videos",
        index + 1
      )
    )
    .filter(Boolean);
}

async function discoverYouTubeVideos(query, { limit }) {
  const url = new URL("https://www.youtube.com/results");
  url.searchParams.set("search_query", query);
  url.searchParams.set("hl", "en");
  url.searchParams.set("gl", "US");

  const response = await fetch(url, {
    headers: {
      "user-agent": VIDEO_SEARCH_UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.8"
    },
    signal: AbortSignal.timeout(9000)
  });
  if (!response.ok) throw new Error(`youtube_search_${response.status}`);

  const html = await response.text();
  const initialData =
    extractJsonAfterMarker(html, "var ytInitialData =") ||
    extractJsonAfterMarker(html, "ytInitialData =") ||
    extractJsonAfterMarker(html, '"ytInitialData":');

  if (!initialData) return [];

  const renderers = collectVideoRenderers(initialData, Math.max(limit * 3, 24));
  const rows = [];

  for (const renderer of renderers) {
    const videoId = clean(renderer.videoId, 20);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;

    const title = simpleText(renderer.title);
    const creator = simpleText(renderer.ownerText || renderer.longBylineText || renderer.shortBylineText);
    const creatorBrowseId =
      renderer.ownerText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
      renderer.longBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId ||
      null;
    const thumbnails = renderer.thumbnail?.thumbnails || [];
    const thumbnail = thumbnails[thumbnails.length - 1]?.url || null;
    const duration = simpleText(renderer.lengthText);

    rows.push(
      normalizeVideoRow(
        {
          title,
          video_url: `https://www.youtube.com/watch?v=${videoId}`,
          source_url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail_url: thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          creator,
          creator_url: creatorBrowseId
            ? `https://www.youtube.com/channel/${creatorBrowseId}`
            : null,
          duration,
          published_text: simpleText(renderer.publishedTimeText),
          views_text: simpleText(renderer.viewCountText || renderer.shortViewCountText)
        },
        "youtube-search",
        rows.length + 1
      )
    );
  }

  return rows.filter(Boolean);
}

function fuseVideoRows(rows, options) {
  const preferredDomains = (options.preferredDomains || []).map(normalizeDomain).filter(Boolean);
  const excludedDomains = (options.excludedDomains || []).map(normalizeDomain).filter(Boolean);
  const seen = new Set();
  const filtered = [];

  for (const row of rows) {
    if (!row?.video_url) continue;
    if (seen.has(row.video_url)) continue;
    seen.add(row.video_url);

    if (preferredDomains.length && !hostMatches(row.video_url, preferredDomains)) continue;
    if (excludedDomains.length && hostMatches(row.video_url, excludedDomains)) continue;

    filtered.push(row);
    if (filtered.length >= options.limit) break;
  }

  return filtered.map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function searchVideos(query, options = {}) {
  const q = clean(query, 1000);
  if (!q) throw new Error("query_required");

  const normalized = {
    limit: clampInt(options.limit || options.maxResults, 12, 1, 30),
    safeSearch: normalizeSafeSearch(options.safeSearch || options.safe_search),
    preferredDomains: Array.isArray(options.preferredDomains || options.preferred_domains)
      ? (options.preferredDomains || options.preferred_domains).slice(0, 12)
      : [],
    excludedDomains: Array.isArray(options.excludedDomains || options.excluded_domains)
      ? (options.excludedDomains || options.excluded_domains).slice(0, 12)
      : [],
    cacheTtl: clampInt(options.cacheTtl || options.cache_ttl, 1800, 30, 21600)
  };

  const providerSet = process.env.SEARCH_DISCOVERY_BASE_URL
    ? "searxng-videos+youtube-search"
    : "youtube-search";

  const cacheKey = sha256(JSON.stringify({
    cacheVersion: VIDEO_CACHE_VERSION,
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

  const jobs = [];
  if (process.env.SEARCH_DISCOVERY_BASE_URL) {
    jobs.push(
      discoverSearxVideos(q, normalized)
        .then((rows) => ({ provider: "searxng-videos", rows }))
        .catch((error) => ({ provider: "searxng-videos", rows: [], error: error?.message }))
    );
  }

  jobs.push(
    discoverYouTubeVideos(q, normalized)
      .then((rows) => ({ provider: "youtube-search", rows }))
      .catch((error) => ({ provider: "youtube-search", rows: [], error: error?.message }))
  );

  const settled = await Promise.all(jobs);
  const attempts = [];
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

  const results = fuseVideoRows(allRows, normalized);
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
      preferred_domains: normalized.preferredDomains,
      excluded_domains: normalized.excludedDomains
    },
    rights_notice:
      "Video search returns links and upstream rights metadata. It does not download, rehost, or grant reuse rights. rights_verified=false means copyright, license, and attribution must be verified on source_url before reuse or redistribution.",
    safe_search_notice:
      "Safe-search strength depends on the upstream provider. SearxNG honors the requested level; direct YouTube discovery does not provide an equivalent guaranteed API flag."
  };

  void setDiscoveryCache(cacheKey, value, normalized.cacheTtl).catch(() => {});
  return value;
}
