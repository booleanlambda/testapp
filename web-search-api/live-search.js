import { discoverWeb } from "./discovery.js";
import { crawlSite } from "./crawler.js";
import { getDocument } from "./storage.js";
import { searchIndex } from "./search.js";

function isFresh(document, freshSeconds) {
  if (!document?.crawledAt) return false;
  const ageMs = Date.now() - new Date(document.crawledAt).getTime();
  return ageMs >= 0 && ageMs <= freshSeconds * 1000;
}

async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;

  async function run() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => run())
  );
  return results;
}

export async function liveSearch(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query_required");

  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const maxDiscover = Math.max(limit, Math.min(Number(options.maxDiscover || 8), 20));
  const maxCrawl = Math.max(1, Math.min(Number(options.maxCrawl || 5), 10));
  const freshSeconds = Math.max(60, Math.min(Number(options.freshSeconds || 1800), 86400));

  const discovery = await discoverWeb(q, {
    limit: maxDiscover,
    cacheTtl: Math.min(freshSeconds, 1800)
  });

  const selected = discovery.results.slice(0, maxCrawl);
  const crawlActivity = await mapLimit(selected, 2, async (row) => {
    try {
      const existing = await getDocument(row.url);
      if (isFresh(existing, freshSeconds)) {
        return {
          url: row.url,
          canonicalUrl: existing.url || row.url,
          status: "reused",
          crawledAt: existing.crawledAt
        };
      }

      const result = await crawlSite(row.url, {
        maxPages: 1,
        depth: 0,
        sameOrigin: true,
        respectRobots: true
      });

      return {
        url: row.url,
        canonicalUrl: result.pages?.[0]?.url || row.url,
        status: result.indexedPages > 0 ? "indexed" : "failed",
        indexedPages: result.indexedPages,
        failures: result.failures
      };
    } catch (error) {
      return {
        url: row.url,
        status: "failed",
        error: String(error?.message || "crawl_failed").slice(0, 300)
      };
    }
  });

  const candidateUrls = [...new Set(
    crawlActivity
      .filter((row) => row && (row.status === "indexed" || row.status === "reused"))
      .map((row) => row.canonicalUrl || row.url)
      .filter(Boolean)
  )];
  let ranked = {
    query: q,
    embeddingModel: null,
    candidateCount: 0,
    results: []
  };

  if (candidateUrls.length) {
    try {
      ranked = await searchIndex(q, {
        limit,
        urls: candidateUrls,
        candidateLimit: 2000,
        perDocument: discovery.strictPrecision ? 4 : 2
      });
    } catch {}
  }

  const rankedUrls = new Set(ranked.results.map((row) => row.url));
  const fallback = discovery.results
    .filter((row) => !rankedUrls.has(row.url))
    .slice(0, Math.max(0, limit - ranked.results.length))
    .map((row) => ({
      title: row.title,
      url: row.url,
      content: row.snippet,
      score: null,
      semanticScore: null,
      lexicalScore: null,
      chunk: null,
      crawledAt: null,
      fallback: true
    }));

  return {
    query: q,
    mode: "live",
    discovery: {
      provider: discovery.provider,
      intent: discovery.intent,
      anchors: discovery.anchors,
      precisionAnchors: discovery.precisionAnchors,
      strictPrecision: discovery.strictPrecision,
      effectiveQueries: discovery.effectiveQueries,
      cached: discovery.cached,
      discoveredAt: discovery.discoveredAt,
      resultCount: discovery.results.length
    },
    crawl: {
      attempted: selected.length,
      indexed: crawlActivity.filter((x) => x?.status === "indexed").length,
      reused: crawlActivity.filter((x) => x?.status === "reused").length,
      failed: crawlActivity.filter((x) => x?.status === "failed").length,
      activity: crawlActivity
    },
    embeddingModel: ranked.embeddingModel,
    results: [...ranked.results, ...fallback].slice(0, limit)
  };
}
