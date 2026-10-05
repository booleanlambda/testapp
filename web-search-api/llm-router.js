let cachedModel = null;
let cachedModelAt = 0;
let cachedCandidates = [];
let cachedCandidatesAt = 0;
const planCache = new Map();

const PLAN_TTL_MS = 10 * 60 * 1000;
const MODEL_TTL_MS = 60 * 60 * 1000;
const VALID_INTENTS = new Set([
  "general",
  "news",
  "technical",
  "technical_tutorial",
  "technical_comparison",
  "commercial"
]);

function uniq(values) {
  return [...new Set(values.filter(Boolean))];
}

function providerConfig() {
  const raw = process.env.LLM_BASE_URL || process.env.EMBEDDING_BASE_URL;
  const apiKey = process.env.LLM_API_KEY || process.env.EMBEDDING_API_KEY;
  if (!raw || !apiKey) return null;

  const base = new URL(raw);
  const clean = base.pathname.replace(/\/+$/, "");
  const suffixes = ["/embeddings", "/chat/completions", "/completions"];
  let rootPath = clean;
  for (const suffix of suffixes) {
    if (rootPath.endsWith(suffix)) {
      rootPath = rootPath.slice(0, -suffix.length);
      break;
    }
  }

  const root = new URL(base.toString());
  root.pathname = rootPath || "/";
  root.search = "";
  root.hash = "";

  const models = new URL(root.toString());
  models.pathname = (root.pathname.replace(/\/+$/, "") || "") + "/models";

  const chat = new URL(root.toString());
  chat.pathname = (root.pathname.replace(/\/+$/, "") || "") + "/chat/completions";

  return {
    apiKey,
    models: models.toString(),
    chat: chat.toString(),
    explicitModel: process.env.LLM_MODEL?.trim() || null
  };
}

function headers(config) {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey}`
  };
}

function scoreChatModel(id = "") {
  const s = String(id).toLowerCase();
  if (!s) return -1000;
  if (/embed|embedding|rerank|retrieval|audio|speech|tts|image|vision/.test(s)) return -1000;

  let score = 10;
  if (/instruct|chat|assistant/.test(s)) score += 70;
  if (/llama|qwen|mistral|gemma|nemotron|phi/.test(s)) score += 25;
  if (/\b(1|2|3|4|7|8|9|12)b\b|[-_/](1|2|3|4|7|8|9|12)b([-_/]|$)/.test(s)) score += 18;
  if (/mini|small|flash/.test(s)) score += 16;
  if (/reason|thinking/.test(s)) score -= 8;
  if (/\b(34|40|70|72|405)b\b|[-_/](34|40|70|72|405)b([-_/]|$)/.test(s)) score -= 35;
  return score;
}

async function discoverCandidates(config, force = false) {
  if (config.explicitModel) return [config.explicitModel];

  if (!force && cachedCandidates.length && Date.now() - cachedCandidatesAt < MODEL_TTL_MS) {
    return cachedCandidates;
  }

  try {
    const response = await fetch(config.models, {
      headers: headers(config),
      signal: AbortSignal.timeout(6000)
    });
    if (!response.ok) return [];

    const json = await response.json();
    const ids = Array.isArray(json?.data)
      ? json.data.map((row) => row?.id).filter(Boolean)
      : [];

    cachedCandidates = ids
      .map((id) => ({ id, score: scoreChatModel(id) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((row) => row.id)
      .slice(0, 10);

    cachedCandidatesAt = Date.now();
    return cachedCandidates;
  } catch {
    return [];
  }
}

function extractContent(json) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
  }
  return "";
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const unfenced = raw
    .replace(/^\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`$/i, "")
    .trim();

  try {
    return JSON.parse(unfenced);
  } catch {}

  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(unfenced.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function normalizeHost(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  try {
    const url = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizePlan(raw) {
  if (!raw || typeof raw !== "object") return null;

  const intent = VALID_INTENTS.has(raw.intent) ? raw.intent : null;
  const entities = Array.isArray(raw.entities)
    ? raw.entities.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const concepts = Array.isArray(raw.concepts)
    ? raw.concepts.map((x) => String(x || "").trim()).filter((x) => x.length >= 2).slice(0, 10)
    : [];
  const officialDomains = Array.isArray(raw.official_domains)
    ? uniq(raw.official_domains.map(normalizeHost).filter(Boolean)).slice(0, 5)
    : [];
  const queries = Array.isArray(raw.queries)
    ? uniq(raw.queries.map((x) => String(x || "").trim()).filter(Boolean)).slice(0, 3)
    : [];

  if (!intent && !queries.length && !concepts.length) return null;

  return {
    intent,
    entities,
    concepts,
    officialDomains,
    queries,
    strictPrecision: Boolean(raw.strict_precision),
    brand: typeof raw.brand === "string" && raw.brand.trim()
      ? raw.brand.trim().toLowerCase()
      : null
  };
}

async function requestPlan(config, model, query) {
  const system = [
    "You are a search query planner for an autonomous web search engine.",
    "Classify the query and produce search instructions, not an answer.",
    "Return ONLY one JSON object with this schema:",
    '{"intent":"general|news|technical|technical_tutorial|technical_comparison|commercial","entities":["..."],"concepts":["..."],"brand":"canonical product/project/entity label or null","official_domains":["example.org"],"queries":["..."],"strict_precision":true}',
    "Preserve exact technical identifiers such as process.nextTick, queueMicrotask, flags, function names, model names, and configuration keys.",
    "For technical questions prefer primary/official documentation. If an official domain is confidently known, include it and make the first query a site: query against it.",
    "For comparisons, preserve the compared category and target. For news, preserve recency/date terms.",
    "Do not invent a domain when unsure. Use at most 3 concise search queries."
  ].join(" ");

  const response = await fetch(config.chat, {
    method: "POST",
    headers: headers(config),
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: query }
      ],
      temperature: 0,
      max_tokens: 500
    }),
    signal: AbortSignal.timeout(7000)
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`llm_planner_request_failed_${response.status}`);
    error.status = response.status;
    error.detail = text.slice(0, 300);
    throw error;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("llm_planner_invalid_response");
  }

  const plan = normalizePlan(parseJsonObject(extractContent(json)));
  if (!plan) throw new Error("llm_planner_invalid_plan");
  return plan;
}

async function resolvePlan(query) {
  const config = providerConfig();
  if (!config) return null;

  const key = query.trim().toLowerCase();
  const cached = planCache.get(key);
  if (cached && Date.now() - cached.at < PLAN_TTL_MS) return cached.value;

  let candidates;
  if (cachedModel && Date.now() - cachedModelAt < MODEL_TTL_MS) {
    candidates = uniq([cachedModel, ...(await discoverCandidates(config))]);
  } else {
    candidates = await discoverCandidates(config);
  }

  let lastError = null;
  for (const model of candidates.slice(0, 4)) {
    try {
      const plan = await requestPlan(config, model, query);
      cachedModel = model;
      cachedModelAt = Date.now();
      const value = { plan, model };
      planCache.set(key, { at: Date.now(), value });
      if (planCache.size > 200) {
        const first = planCache.keys().next().value;
        planCache.delete(first);
      }
      return value;
    } catch (error) {
      lastError = error;
      if (![400, 404, 405, 422, 429, 500, 502, 503, 504].includes(error?.status)) break;
    }
  }

  if (lastError && process.env.LLM_ROUTER_DEBUG === "1") {
    console.warn("LLM_ROUTER_FALLBACK", JSON.stringify({ error: lastError.message }));
  }
  return null;
}

function normalizeConcept(value) {
  return String(value || "").trim().toLowerCase();
}

export async function enrichQueryAnalysis(query, fallback) {
  let resolved = null;
  try {
    resolved = await resolvePlan(String(query || ""));
  } catch {}

  if (!resolved?.plan) {
    return {
      ...fallback,
      planner: {
        provider: "deterministic-fallback",
        model: null
      }
    };
  }

  const { plan, model } = resolved;
  const intent = plan.intent || fallback.intent;
  const llmAnchors = uniq([
    ...plan.entities.map(normalizeConcept),
    ...plan.concepts.map(normalizeConcept)
  ]).filter((x) => x.length >= 3);

  const conceptPrecision = plan.concepts
    .map(normalizeConcept)
    .filter((x) => x.length >= 4)
    .slice(0, 5);

  const anchors = uniq([...llmAnchors, ...(fallback.anchors || [])]).slice(0, 12);
  const precisionAnchors = uniq([
    ...conceptPrecision,
    ...(fallback.precisionAnchors || [])
  ]).slice(0, 5);

  const phrases = uniq([
    ...(fallback.phrases || []),
    ...plan.concepts
      .map(normalizeConcept)
      .filter((x) => /[ ._-]/.test(x) && x.length >= 4)
  ]).slice(0, 10);

  const variants = uniq([
    ...plan.queries,
    ...(fallback.variants || [])
  ]).slice(0, 3);

  const strictPrecision =
    plan.strictPrecision ||
    fallback.strictPrecision ||
    (intent.startsWith("technical") && precisionAnchors.length >= 2);

  return {
    ...fallback,
    intent,
    anchors,
    precisionAnchors,
    phrases,
    brand: plan.brand || fallback.brand,
    strictPrecision,
    variants,
    officialDomains: plan.officialDomains,
    planner: {
      provider: "llm",
      model
    }
  };
}

export function llmPlannerState() {
  const config = providerConfig();
  return {
    configured: Boolean(config),
    dynamicModel: Boolean(config && !config.explicitModel),
    activeModel: cachedModel
  };
}
