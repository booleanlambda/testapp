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

async function crawlRow(row, freshSeconds) {
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
}

async function crawlRows(rows, freshSeconds) {
  return mapLimit(rows, 2, (row) => crawlRow(row, freshSeconds));
}

async function rankUrls(query, urls, limit, perDocument) {
  if (!urls.length) {
    return {
      query,
      embeddingModel: null,
      candidateCount: 0,
      results: []
    };
  }

  try {
    return await searchIndex(query, {
      limit,
      urls,
      candidateLimit: 2000,
      perDocument
    });
  } catch {
    return {
      query,
      embeddingModel: null,
      candidateCount: 0,
      results: []
    };
  }
}

async function crawlUntilEvidence({
  rows,
  freshSeconds,
  query,
  activity = [],
  maxTotal,
  requiredEvidence,
  limit,
  perDocument
}) {
  let nextActivity = [...activity];
  let ranked = await rankUrls(
    query,
    successfulCandidateUrls(nextActivity),
    limit,
    perDocument
  );
  let evidence = evidenceCoverage(requiredEvidence, ranked.results);
  let processed = 0;

  for (const row of rows) {
    if (nextActivity.length >= maxTotal || evidence.complete) break;
    const result = await crawlRow(row, freshSeconds);
    nextActivity.push(result);
    processed += 1;

    ranked = await rankUrls(
      query,
      successfulCandidateUrls(nextActivity),
      limit,
      perDocument
    );
    evidence = evidenceCoverage(requiredEvidence, ranked.results);
  }

  return {
    activity: nextActivity,
    ranked,
    evidence,
    processed
  };
}

function successfulCandidateUrls(activity) {
  return [...new Set(
    activity
      .filter((row) => row && (row.status === "indexed" || row.status === "reused"))
      .map((row) => row.canonicalUrl || row.url)
      .filter(Boolean)
  )];
}

function evidenceRetryQuery(agentRequest, missing, originalQuery) {
  const preferred = agentRequest?.preferredDomains?.[0] || null;
  const entities = Array.isArray(agentRequest?.entities) ? agentRequest.entities : [];
  const concepts = Array.isArray(agentRequest?.concepts) ? agentRequest.concepts : [];
  const quote = (value) => {
    const text = String(value || "").trim().replace(/"/g, "");
    return text ? (/\s/.test(text) ? `"${text}"` : text) : "";
  };

  const coreEntity = entities.length > 1
    ? entities[entities.length - 1]
    : entities[0] || "";
  const missingTerm = (missing || [])[0] || concepts[0] || "";

  return [
    preferred ? `site:${preferred}` : "",
    coreEntity,
    quote(missingTerm),
    preferred ? "" : originalQuery
  ].filter(Boolean).join(" ");
}

function eligibleRows(rows, excludedDomains, preferredDomains, primaryOnly) {
  return (rows || []).filter((row) => {
    const host = hostname(row.url);
    if (excludedDomains.some((domain) => domainMatches(host, domain))) return false;
    if (primaryOnly && !preferredDomains.some((domain) => domainMatches(host, domain))) return false;
    return true;
  });
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

  let allDiscoveryResults = eligibleRows(
    discovery.results,
    excludedDomains,
    preferredDomains,
    primaryOnly
  );

  const selected = allDiscoveryResults.slice(0, maxCrawl);
  const requiredEvidence = options.agentRequest?.requiredEvidence || [];

  let crawlActivity;
  let ranked;
  let evidence;

  if (options.agentRequest && requiredEvidence.length) {
    const firstPass = await crawlUntilEvidence({
      rows: selected,
      freshSeconds,
      query: q,
      activity: [],
      maxTotal: maxCrawl,
      requiredEvidence,
      limit,
      perDocument: discovery.strictPrecision ? 4 : 2
    });
    crawlActivity = firstPass.activity;
    ranked = firstPass.ranked;
    evidence = firstPass.evidence;
  } else {
    crawlActivity = await crawlRows(selected, freshSeconds);
    ranked = await rankUrls(
      q,
      successfulCandidateUrls(crawlActivity),
      limit,
      discovery.strictPrecision ? 4 : 2
    );
    evidence = evidenceCoverage(requiredEvidence, ranked.results);
  }

  let candidateUrls = successfulCandidateUrls(crawlActivity);
  let evidenceRetry = null;

  const remainingCrawl = Math.max(0, maxCrawl - crawlActivity.length);
  if (
    options.agentRequest &&
    !evidence.complete &&
    evidence.missing.length &&
    remainingCrawl > 0
  ) {
    const retryQuery = evidenceRetryQuery(options.agentRequest, evidence.missing, q);
    const retryAnalysis = options.analysis ? {
      ...options.analysis,
      variants: [retryQuery],
      strictPrecision: false,
      precisionAnchors: [
        ...new Set([
          ...evidence.missing.map((x) => String(x).toLowerCase()),
          ...(options.analysis.precisionAnchors || [])
        ])
      ].slice(0, 8),
      planner: {
        ...(options.analysis.planner || {}),
        retry: "missing-evidence"
      }
    } : null;

    try {
      const retryDiscovery = await discoverWeb(q, {
        limit: maxDiscover,
        cacheTtl: Math.min(freshSeconds, 1800),
        analysis: retryAnalysis,
        maxMs: 18000
      });

      const alreadySeen = new Set(
        allDiscoveryResults.map((row) => row.url)
          .concat(crawlActivity.map((row) => row?.url).filter(Boolean))
      );

      const retryEligible = eligibleRows(
        retryDiscovery.results,
        excludedDomains,
        preferredDomains,
        primaryOnly
      ).filter((row) => !alreadySeen.has(row.url));

      const retrySelected = retryEligible.slice(0, remainingCrawl);
      const missingBefore = [...evidence.missing];
      const retryPass = await crawlUntilEvidence({
        rows: retrySelected,
        freshSeconds,
        query: q,
        activity: crawlActivity,
        maxTotal: maxCrawl,
        requiredEvidence: options.agentRequest.requiredEvidence || [],
        limit,
        perDocument: 3
      });

      crawlActivity = retryPass.activity;
      ranked = retryPass.ranked;
      evidence = retryPass.evidence;
      allDiscoveryResults = [...allDiscoveryResults, ...retryEligible];
      candidateUrls = successfulCandidateUrls(crawlActivity);

      evidenceRetry = {
        attempted: true,
        query: retryQuery,
        missingBefore,
        discovered: retryDiscovery.results.length,
        attempts: retryDiscovery.attempts || [],
        crawled: retryPass.processed,
        completeAfter: evidence.complete,
        stoppedEarly: evidence.complete && retryPass.processed < retrySelected.length
      };
    } catch (error) {
      evidenceRetry = {
        attempted: true,
        query: retryQuery,
        error: String(error?.message || "evidence_retry_failed").slice(0, 240),
        completeAfter: false
      };
    }
  }

  const rankedUrls = new Set(ranked.results.map((row) => row.url));
  const fallback = allDiscoveryResults
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
  evidence = {
    ...evidence,
    retry: evidenceRetry
  };

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
      attempts: discovery.attempts || [],
      cached: discovery.cached,
      discoveredAt: discovery.discoveredAt,
      resultCount: discovery.results.length
    },
    crawl: {
      attempted: crawlActivity.length,
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
