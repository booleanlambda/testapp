import { discoverWeb } from "./discovery.js";
import { crawlSite } from "./crawler.js";
import { getDocument } from "./storage.js";
import { searchIndex } from "./search.js";

function isFresh(document, freshSeconds) {
  if (!document?.crawledAt) return false;
  const ageMs = Date.now() - new Date(document.crawledAt).getTime();
  return ageMs >= 0 && ageMs <= freshSeconds * 1000;
}

function hostname(rawUrl) {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function domainMatches(host, domain) {
  const d = String(domain || "").toLowerCase().replace(/^www\./, "");
  return Boolean(d) && (host === d || host.endsWith(`.${d}`));
}

function normalizeEvidenceText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evidenceCoverage(required, rows) {
  const terms = Array.isArray(required) ? required.filter(Boolean) : [];
  if (!terms.length) {
    return {
      required: [],
      matched: [],
      missing: [],
      complete: true
    };
  }

  const evidence = normalizeEvidenceText(
    rows.map((row) => `${row.title || ""}\n${row.content || ""}\n${row.url || ""}`).join("\n")
  );

  const matched = [];
  const missing = [];

  for (const term of terms) {
    const needle = normalizeEvidenceText(term);
    if (needle && evidence.includes(needle)) matched.push(term);
    else missing.push(term);
  }

  return {
    required: terms,
    matched,
    missing,
    complete: missing.length === 0
  };
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
    cacheTtl: Math.min(freshSeconds, 1800),
    analysis: options.analysis || null
  });

  const excludedDomains = Array.isArray(options.agentRequest?.excludedDomains)
    ? options.agentRequest.excludedDomains
    : [];
  const preferredDomains = Array.isArray(options.agentRequest?.preferredDomains)
    ? options.agentRequest.preferredDomains
    : [];
  const primaryOnly =
    options.agentRequest?.sourcePolicy === "primary" &&
    preferredDomains.length > 0;

  const eligibleDiscoveryResults = discovery.results.filter((row) => {
    const host = hostname(row.url);
    if (excludedDomains.some((domain) => domainMatches(host, domain))) return false;
    if (primaryOnly && !preferredDomains.some((domain) => domainMatches(host, domain))) return false;
    return true;
  });

  const selected = eligibleDiscoveryResults.slice(0, maxCrawl);
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
  const fallback = eligibleDiscoveryResults
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

  const combinedResults = [...ranked.results, ...fallback].slice(0, limit);
  const evidence = evidenceCoverage(
    options.agentRequest?.requiredEvidence || [],
    ranked.results
  );

  return {
    query: q,
    mode: "live",
    protocol: options.agentRequest?.protocol || null,
    agent: options.agentRequest ? {
      goal: options.agentRequest.goal,
      sourcePolicy: options.agentRequest.sourcePolicy,
      depth: options.agentRequest.depth,
      preferredDomains: options.agentRequest.preferredDomains,
      excludedDomains: options.agentRequest.excludedDomains
    } : null,
    discovery: {
      provider: discovery.provider,
      intent: discovery.intent,
      anchors: discovery.anchors,
      precisionAnchors: discovery.precisionAnchors,
      strictPrecision: discovery.strictPrecision,
      effectiveQueries: discovery.effectiveQueries,
      planner: discovery.planner || null,
      officialDomains: discovery.officialDomains || [],
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
    evidence,
    results: combinedResults
  };
}
