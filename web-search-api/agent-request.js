import { analyzeQuery } from "./intent.js";

export const AGENT_SEARCH_PROTOCOL = "agent-search-v1";

const INTENTS = new Set([
  "general",
  "news",
  "technical",
  "technical_tutorial",
  "technical_comparison",
  "commercial"
]);

const GOALS = new Set([
  "find",
  "explain",
  "verify",
  "compare",
  "research",
  "collect_evidence",
  "monitor"
]);

const SOURCE_POLICIES = new Set([
  "primary",
  "authoritative",
  "broad_web",
  "community"
]);

const DEPTHS = new Set(["quick", "normal", "deep"]);

function list(value, max = 12) {
  if (!Array.isArray(value)) return [];
  return [...new Set(
    value
      .map((x) => String(x || "").trim())
      .filter(Boolean)
  )].slice(0, max);
}

function hostList(value, max = 12) {
  return list(value, max)
    .map((host) => host.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, ""))
    .filter((host) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host));
}

function boundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(Math.floor(n), max));
}

function freshnessSeconds(value) {
  if (value == null || value === "any") return 86400;
  if (value === "realtime") return 120;
  if (value === "24h") return 3600;
  if (value === "7d") return 21600;
  return boundedInt(value, 1800, 60, 86400);
}

function uniqLower(values, max = 16) {
  return [...new Set(values.map((x) => String(x || "").trim().toLowerCase()).filter(Boolean))].slice(0, max);
}

function queryContextPhrase(query, anchors = []) {
  const lower = String(query || "").toLowerCase().replace(/[^a-z0-9._-]+/g, " ").trim();
  const ordered = (anchors || []).map((value) => String(value || "").toLowerCase()).filter(Boolean);

  for (let width = Math.min(3, ordered.length); width >= 2; width -= 1) {
    for (let i = 0; i <= ordered.length - width; i += 1) {
      const phrase = ordered.slice(i, i + width).join(" ");
      if (phrase.length >= 8 && lower.includes(phrase)) return phrase;
    }
  }

  return null;
}

function queryVariants(query, request, baseline) {
  const concepts = request.concepts.slice(0, 6);
  const entities = request.entities.slice(0, 3);
  const evidence = request.requiredEvidence.slice(0, 6);
  const focusItems = [...new Set([...entities, ...concepts, ...evidence])];
  const focus = focusItems.join(" ").replace(/\s+/g, " ").trim();
  const variants = [query];

  const quoteDistinctive = (value) => {
    const text = String(value || "").trim();
    if (!text) return "";
    return /[\s-]/.test(text) ? `"${text.replace(/"/g, "")}"` : text;
  };

  if (request.preferredDomains.length && focus) {
    const coreEntity = entities.length > 1
      ? entities[entities.length - 1]
      : entities[0] || "";
    const strongestConcept = concepts[0] || evidence[0] || "";
    variants.unshift(
      [
        `site:${request.preferredDomains[0]}`,
        coreEntity,
        quoteDistinctive(strongestConcept)
      ].filter(Boolean).join(" ")
    );
  }

  if (focus) {
    const suffix = request.sourcePolicy === "primary"
      ? "official documentation"
      : request.goal === "verify"
        ? "source evidence"
        : "";
    variants.push(`${focus} ${suffix}`.trim());
  }

  variants.push(...(baseline.variants || []));
  return [...new Set(variants.filter(Boolean))].slice(0, 3);
}

export function parseAgentSearchRequest(body = {}) {
  if (body.protocol !== AGENT_SEARCH_PROTOCOL) return null;

  const query = String(body.query || body.q || "").trim();
  if (!query) throw new Error("query_required");

  const baseline = analyzeQuery(query);
  const intent = body.intent == null ? baseline.intent : String(body.intent).trim();
  if (!INTENTS.has(intent)) throw new Error("invalid_agent_intent");

  const goal = body.goal == null ? "find" : String(body.goal).trim();
  if (!GOALS.has(goal)) throw new Error("invalid_agent_goal");

  const sourcePolicy = body.source_policy == null ? "authoritative" : String(body.source_policy).trim();
  if (!SOURCE_POLICIES.has(sourcePolicy)) throw new Error("invalid_source_policy");

  const depth = body.depth == null ? "normal" : String(body.depth).trim();
  if (!DEPTHS.has(depth)) throw new Error("invalid_search_depth");

  const entities = list(body.entities, 8);
  const concepts = list(body.concepts, 12);
  const preferredDomains = hostList(body.preferred_domains, 12);
  const excludedDomains = hostList(body.excluded_domains, 12);
  const requiredEvidence = list(body.required_evidence, 12);

  const depthDefaults = {
    quick: { maxDiscover: 6, maxCrawl: 3 },
    normal: { maxDiscover: 10, maxCrawl: 5 },
    deep: { maxDiscover: 16, maxCrawl: 8 }
  }[depth];

  const request = {
    protocol: AGENT_SEARCH_PROTOCOL,
    query,
    intent,
    goal,
    entities,
    concepts,
    sourcePolicy,
    preferredDomains,
    excludedDomains,
    requiredEvidence,
    depth,
    limit: boundedInt(body.max_results ?? body.limit, 5, 1, 20),
    maxDiscover: boundedInt(body.max_discover, depthDefaults.maxDiscover, 1, 20),
    maxCrawl: boundedInt(body.crawl_budget ?? body.max_crawl, depthDefaults.maxCrawl, 1, 10),
    freshSeconds: freshnessSeconds(body.freshness),
    output: String(body.output || "passages").trim()
  };

  if (request.output !== "passages") throw new Error("invalid_agent_output");

  const suppliedSemanticTokens = new Set(
    [...entities, ...concepts, ...requiredEvidence]
      .flatMap((value) => String(value || "").toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [])
  );

  const queryOnlyAnchors = (baseline.anchors || [])
    .filter((anchor) => {
      const token = String(anchor || "").toLowerCase();
      if (!token || suppliedSemanticTokens.has(token)) return false;
      if (/^20\d{2}(?:[-/]\d{1,2}){0,2}$/.test(token)) return false;
      if (/^\d+$/.test(token)) return false;
      return token.length >= 4;
    })
    .slice(0, 6);

  const anchorInput = [
    ...entities,
    ...concepts,
    ...requiredEvidence,
    ...(baseline.anchors || [])
  ];

  const precisionInput = [
    ...concepts,
    ...(baseline.precisionAnchors || [])
  ];

  const analysis = {
    ...baseline,
    intent,
    anchors: uniqLower(anchorInput, 12),
    precisionAnchors: uniqLower(precisionInput, 8),
    phrases: uniqLower([...(baseline.phrases || []), ...concepts.filter((x) => x.includes(" "))], 10),
    brand: entities[0] ? entities[0].toLowerCase() : baseline.brand,
    // Required evidence is validated after crawling. Do not reject candidate pages
    // merely because search-result snippets do not contain every requested term.
    strictPrecision: body.strict_discovery === true,
    variants: [],
    planner: {
      provider: "agent-structured",
      model: null,
      protocol: AGENT_SEARCH_PROTOCOL
    },
    sourcePolicy,
    goal,
    requiredEvidence,
    queryOnlyAnchors,
    officialDomains: preferredDomains
  };

  analysis.variants = queryVariants(query, request, analysis);

  if (sourcePolicy === "broad_web" && queryOnlyAnchors.length) {
    const contextPhrase = queryContextPhrase(query, queryOnlyAnchors);
    analysis.queryContextPhrase = contextPhrase;

    if (contextPhrase) {
      const semanticFocus = concepts[0] || entities[0] || "";
      const focused = [`"${contextPhrase}"`, semanticFocus]
        .filter(Boolean)
        .join(" ");
      analysis.variants = [...new Set([focused, ...analysis.variants])].slice(0, 3);
    }
  }

  return { request, analysis };
}

export function agentSearchSchema() {
  return {
    protocol: AGENT_SEARCH_PROTOCOL,
    method: "POST",
    path: "/search",
    required: ["protocol", "query"],
    example: {
      protocol: AGENT_SEARCH_PROTOCOL,
      query: "What does copy-on-write mean for Redis background saves, and why can Transparent Huge Pages increase latency?",
      intent: "technical",
      goal: "explain",
      entities: ["Redis"],
      concepts: ["copy-on-write", "fork", "Transparent Huge Pages", "latency"],
      source_policy: "primary",
      preferred_domains: ["redis.io"],
      required_evidence: ["copy-on-write", "fork", "Transparent Huge Pages", "latency"],
      depth: "deep",
      max_results: 8,
      crawl_budget: 6,
      output: "passages"
    },
    fields: {
      intent: [...INTENTS],
      goal: [...GOALS],
      source_policy: [...SOURCE_POLICIES],
      freshness: ["realtime", "24h", "7d", "any", "seconds"],
      depth: [...DEPTHS],
      entities: "string[]",
      concepts: "string[]",
      preferred_domains: "hostname[]",
      excluded_domains: "hostname[]",
      required_evidence: "string[]",
      strict_discovery: "boolean (default false; required_evidence is checked after crawl)",
      max_results: "1..20",
      crawl_budget: "1..10",
      output: ["passages"]
    }
  };
}
