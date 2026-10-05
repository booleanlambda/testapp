import { randomUUID } from "node:crypto";
import { discoverWeb } from "./discovery.js";
import { crawlSite, fetchPageFast } from "./crawler.js";
import {
  createJob,
  getDiscoveryCache,
  getDocument,
  setDiscoveryCache,
  sha256
} from "./storage.js";
import { publishCrawlJob } from "./queue.js";
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

function fastCacheKey(url) {
  return sha256(`fast-page:v1:${url}`);
}

async function fetchFastCandidate(row, freshSeconds, controller) {
  const key = fastCacheKey(row.url);
  try {
    const cached = await getDiscoveryCache(key);
    if (cached?.text && cached?.url) {
      return {
        row,
        page: cached,
        status: "fast-cache"
      };
    }
  } catch {}

  try {
    const page = await fetchPageFast(row.url, {
      signal: controller.signal,
      timeoutMs: 5000,
      respectRobots: true,
      enrichMarkdown: true
    });

    void setDiscoveryCache(
      key,
      {
        url: page.url,
        sourceUrl: page.sourceUrl,
        title: page.title,
        description: page.description,
        text: String(page.text || "").slice(0, 180000),
        wordCount: page.wordCount,
        extraction: page.extraction,
        cachedAt: new Date().toISOString()
      },
      Math.max(900, Math.min(Number(freshSeconds || 1800), 21600))
    ).catch(() => {});

    return {
      row,
      page,
      status: "fast-fetched"
    };
  } catch (error) {
    return {
      row,
      page: null,
      status: controller.signal.aborted ? "aborted" : "failed",
      error: String(error?.message || "fast_fetch_failed").slice(0, 240)
    };
  }
}

function fastEvidenceRows(pages) {
  return pages.map((page) => ({
    title: page.title,
    url: page.url,
    content: page.text
  }));
}

function pageMatchesQueryContext(page, anchors = [], phrase = null) {
  const terms = [...new Set(
    (anchors || [])
      .map((value) => normalizeEvidenceText(value))
      .filter(Boolean)
  )];

  if (!terms.length) return { ok: true, matched: [], required: 0 };

  const haystack = normalizeEvidenceText(
    `${page?.title || ""}\n${page?.text || ""}\n${page?.url || ""}`
  );
  const normalizedPhrase = normalizeEvidenceText(phrase);
  if (normalizedPhrase && !haystack.includes(normalizedPhrase)) {
    return {
      ok: false,
      matched: terms.filter((term) => haystack.includes(term)),
      required: `phrase:${normalizedPhrase}`
    };
  }

  const matched = terms.filter((term) => haystack.includes(term));
  const required = normalizedPhrase ? 0 : (terms.length >= 2 ? 2 : 1);

  return {
    ok: normalizedPhrase ? true : matched.length >= required,
    matched,
    required
  };
}

function evidencePassage(text, terms = [], concepts = [], maxChars = 2200) {
  const source = String(text || "");
  if (source.length <= maxChars) return source;

  const needles = [...new Set([...terms, ...concepts])]
    .map((x) => String(x || "").trim())
    .filter(Boolean);

  const lower = source.toLowerCase();
  const hits = needles
    .map((needle) => lower.indexOf(needle.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  if (!hits.length) return source.slice(0, maxChars);

  const windows = [];
  for (const hit of hits.slice(0, 4)) {
    const start = Math.max(0, hit - 280);
    const end = Math.min(source.length, hit + 620);
    windows.push(source.slice(start, end));
  }

  const merged = windows.join("\n…\n");
  return merged.length <= maxChars ? merged : merged.slice(0, maxChars);
}

function fastResultScore(page, requiredEvidence, concepts) {
  const haystack = normalizeEvidenceText(`${page.title || ""} ${page.text || ""} ${page.url || ""}`);
  let score = 0;
  for (const term of requiredEvidence || []) {
    const needle = normalizeEvidenceText(term);
    if (needle && haystack.includes(needle)) score += 8;
  }
  for (const term of concepts || []) {
    const needle = normalizeEvidenceText(term);
    if (needle && haystack.includes(needle)) score += 3;
  }
  return score;
}

function fastResults(pages, agentRequest, limit) {
  return pages
    .map((page) => ({
      title: page.title || null,
      url: page.url,
      content: evidencePassage(
        page.text,
        agentRequest?.requiredEvidence || [],
        agentRequest?.concepts || []
      ),
      score: fastResultScore(
        page,
        agentRequest?.requiredEvidence || [],
        agentRequest?.concepts || []
      ),
      semanticScore: null,
      lexicalScore: null,
      chunk: null,
      crawledAt: null,
      fallback: false,
      fastPath: true
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function fetchUntilEvidenceFast({
  rows,
  freshSeconds,
  requiredEvidence,
  concepts,
  maxTotal,
  concurrency = 2,
  queryContextAnchors = [],
  queryContextPhrase = null,
  enforceQueryContext = false
}) {
  const pages = [];
  const activity = [];
  const active = new Map();
  let nextIndex = 0;
  let idSeq = 0;
  const evidenceRequired = Array.isArray(requiredEvidence) && requiredEvidence.length > 0;
  let evidence = evidenceCoverage(requiredEvidence, []);

  const launch = (row) => {
    const id = ++idSeq;
    const controller = new AbortController();
    const promise = fetchFastCandidate(row, freshSeconds, controller)
      .then((result) => ({ id, result }));
    active.set(id, { promise, controller });
  };

  while (nextIndex < rows.length && active.size < Math.min(concurrency, maxTotal)) {
    launch(rows[nextIndex++]);
  }

  while (active.size) {
    const outcome = await Promise.race([...active.values()].map((entry) => entry.promise));
    active.delete(outcome.id);

    const { result } = outcome;
    activity.push({
      url: result.row?.url || null,
      canonicalUrl: result.page?.url || result.row?.url || null,
      status: result.status,
      error: result.error || null
    });

    if (result.page) {
      const context = enforceQueryContext
        ? pageMatchesQueryContext(result.page, queryContextAnchors, queryContextPhrase)
        : { ok: true, matched: [], required: 0 };

      if (context.ok) {
        pages.push(result.page);
        evidence = evidenceCoverage(requiredEvidence, fastEvidenceRows(pages));
      } else {
        activity[activity.length - 1] = {
          ...activity[activity.length - 1],
          status: "context-rejected",
          contextMatched: context.matched,
          contextRequired: context.required
        };
      }
    }

    if ((evidenceRequired && evidence.complete) || activity.length >= maxTotal) {
      for (const entry of active.values()) entry.controller.abort();
      await Promise.allSettled([...active.values()].map((entry) => entry.promise));
      active.clear();
      break;
    }

    while (
      nextIndex < rows.length &&
      active.size < Math.min(concurrency, maxTotal - activity.length)
    ) {
      launch(rows[nextIndex++]);
    }
  }

  return {
    pages,
    activity,
    evidence,
    processed: activity.length
  };
}

function enqueueIndexing(urls) {
  const unique = [...new Set((urls || []).filter(Boolean))].slice(0, 4);
  if (!unique.length) return;

  queueMicrotask(() => {
    void Promise.allSettled(
      unique.map(async (url) => {
        const jobId = randomUUID();
        const options = {
          maxPages: 1,
          depth: 0,
          sameOrigin: true,
          respectRobots: true
        };
        await createJob({ jobId, url, options });
        await publishCrawlJob({ jobId, url, options });
      })
    );
  });
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

  const discoveryCacheTtl = options.agentRequest
    ? 21600
    : Math.min(freshSeconds, 1800);

  const discovery = await discoverWeb(q, {
    limit: maxDiscover,
    cacheTtl: discoveryCacheTtl,
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
  let fastPathUsed = false;
  let fastPages = [];

  if (options.agentRequest) {
    const fastPass = await fetchUntilEvidenceFast({
      rows: selected,
      freshSeconds,
      requiredEvidence,
      concepts: options.agentRequest.concepts || [],
      maxTotal: maxCrawl,
      concurrency: requiredEvidence.length ? 2 : 3,
      queryContextAnchors: options.analysis?.queryOnlyAnchors || [],
      queryContextPhrase: options.analysis?.queryContextPhrase || null,
      enforceQueryContext:
        options.analysis?.planner?.provider === "agent-structured" &&
        options.agentRequest?.sourcePolicy === "broad_web"
    });

    fastPages = fastPass.pages;
    crawlActivity = fastPass.activity;
    evidence = fastPass.evidence;
    fastPathUsed = fastPages.length > 0;

    if (fastPathUsed) {
      ranked = {
        query: q,
        embeddingModel: null,
        candidateCount: fastPages.length,
        results: fastResults(fastPages, options.agentRequest, limit)
      };

      enqueueIndexing(fastPages.map((page) => page.url));
    } else {
      ranked = {
        query: q,
        embeddingModel: null,
        candidateCount: 0,
        results: []
      };
    }
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
        cacheTtl: discoveryCacheTtl,
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

      if (options.agentRequest) {
        const retryPass = await fetchUntilEvidenceFast({
          rows: retrySelected,
          freshSeconds,
          requiredEvidence: options.agentRequest.requiredEvidence || [],
          concepts: options.agentRequest.concepts || [],
          maxTotal: remainingCrawl,
          concurrency: 2,
          queryContextAnchors: options.analysis?.queryOnlyAnchors || [],
          enforceQueryContext:
            options.analysis?.planner?.provider === "agent-structured" &&
            options.agentRequest?.sourcePolicy === "broad_web"
        });

        crawlActivity = [...crawlActivity, ...retryPass.activity];
        fastPages = [...fastPages, ...retryPass.pages];
        fastPathUsed = fastPages.length > 0;
        evidence = evidenceCoverage(
          options.agentRequest.requiredEvidence || [],
          fastEvidenceRows(fastPages)
        );
        ranked = {
          query: q,
          embeddingModel: null,
          candidateCount: fastPages.length,
          results: fastResults(fastPages, options.agentRequest, limit)
        };
        enqueueIndexing(retryPass.pages.map((page) => page.url));

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
      } else {
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
      }

      allDiscoveryResults = [...allDiscoveryResults, ...retryEligible];
      candidateUrls = successfulCandidateUrls(crawlActivity);
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
      fastFetched: crawlActivity.filter((x) => x?.status === "fast-fetched").length,
      fastCache: crawlActivity.filter((x) => x?.status === "fast-cache").length,
      contextRejected: crawlActivity.filter((x) => x?.status === "context-rejected").length,
      failed: crawlActivity.filter((x) => x?.status === "failed").length,
      activity: crawlActivity
    },
    fastPath: fastPathUsed ? {
      used: true,
      embeddingBlockedResponse: false,
      pagesFetched: crawlActivity.filter((x) => x?.status === "fast-fetched").length,
      pagesFromCache: crawlActivity.filter((x) => x?.status === "fast-cache").length
    } : { used: false },
    embeddingModel: ranked.embeddingModel,
    evidence,
    results: combinedResults
  };
}
