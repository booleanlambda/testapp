let cachedModel = null;
let cachedAt = 0;
let cachedCandidates = [];
let candidatesAt = 0;

function endpoints() {
  const raw = process.env.EMBEDDING_BASE_URL;
  if (!raw) throw new Error("embedding_base_url_missing");

  const base = new URL(raw);
  const clean = base.pathname.replace(/\/+$/, "");
  const rootPath = clean.endsWith("/embeddings")
    ? clean.slice(0, -"/embeddings".length)
    : clean;

  const root = new URL(base.toString());
  root.pathname = rootPath || "/";
  root.search = "";
  root.hash = "";

  const embeddings = new URL(root.toString());
  embeddings.pathname = (root.pathname.replace(/\/+$/, "") || "") + "/embeddings";

  const models = new URL(root.toString());
  models.pathname = (root.pathname.replace(/\/+$/, "") || "") + "/models";

  return { embeddings: embeddings.toString(), models: models.toString() };
}

function headers() {
  const h = { "content-type": "application/json" };
  if (process.env.EMBEDDING_API_KEY) {
    h.authorization = `Bearer ${process.env.EMBEDDING_API_KEY}`;
  }
  return h;
}

function scoreModel(id = "") {
  const s = id.toLowerCase();
  let score = 0;

  if (/embed|embedding/.test(s)) score += 100;
  if (/(^|[\/_-])(bge|e5|gte|nomic|jina)([\/_-]|$)/.test(s)) score += 70;
  if (/nv-embed|embedqa/.test(s)) score += 50;
  if (/small|mini|base/.test(s)) score += 10;
  if (/rerank|chat|instruct|vision|audio/.test(s)) score -= 100;

  return score;
}

async function discoverCandidates(force = false) {
  const explicit = process.env.EMBEDDING_MODEL?.trim();
  if (explicit) return [explicit];

  if (!force && cachedCandidates.length && Date.now() - candidatesAt < 60 * 60 * 1000) {
    return cachedCandidates;
  }

  const { models } = endpoints();
  try {
    const response = await fetch(models, {
      headers: headers(),
      signal: AbortSignal.timeout(8000)
    });

    if (response.ok) {
      const json = await response.json();
      const ids = Array.isArray(json?.data)
        ? json.data.map((x) => x?.id).filter(Boolean)
        : [];

      cachedCandidates = ids
        .map((id) => ({ id, score: scoreModel(id) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((x) => x.id);

      candidatesAt = Date.now();
      return cachedCandidates;
    }
  } catch {}

  return [];
}

export async function resolveEmbeddingModel(force = false) {
  const explicit = process.env.EMBEDDING_MODEL?.trim();
  if (explicit) return explicit;

  if (!force && cachedModel && Date.now() - cachedAt < 60 * 60 * 1000) {
    return cachedModel;
  }

  const candidates = await discoverCandidates(force);
  return cachedModel || candidates[0] || null;
}

async function rawEmbeddingRequest(input, model, purpose, hints = false) {
  const { embeddings } = endpoints();
  const body = { input };

  if (model) body.model = model;
  if (hints) {
    body.input_type = purpose === "query" ? "query" : "passage";
    body.encoding_format = "float";
  }

  const response = await fetch(embeddings, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25000)
  });

  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`embedding_request_failed_${response.status}`);
    error.status = response.status;
    error.detail = text.slice(0, 500);
    throw error;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("embedding_response_invalid_json");
  }

  const rows = Array.isArray(json?.data) ? json.data : [];
  if (!rows.length) throw new Error("embedding_response_empty");
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const vectors = rows.map((row) => row.embedding).filter(Array.isArray);
  if (vectors.length !== input.length) throw new Error("embedding_count_mismatch");
  return vectors;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransientEmbeddingError(error) {
  return (
    [408, 429, 500, 502, 503, 504].includes(error?.status) ||
    ["AbortError", "TimeoutError", "TypeError"].includes(error?.name)
  );
}

async function requestWithRetry(input, model, purpose, hints) {
  let lastError = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await rawEmbeddingRequest(input, model, purpose, hints);
    } catch (error) {
      lastError = error;
      if (!isTransientEmbeddingError(error) || attempt === 2) throw error;
      await sleep(350 * (2 ** attempt));
    }
  }

  throw lastError || new Error("embedding_request_failed");
}

async function requestEmbeddingBatch(input, model, purpose) {
  try {
    return await requestWithRetry(input, model, purpose, false);
  } catch (error) {
    if (error?.status === 400 || error?.status === 422) {
      return requestWithRetry(input, model, purpose, true);
    }
    throw error;
  }
}

async function chooseWorkingModel(sample, purpose) {
  const explicit = process.env.EMBEDDING_MODEL?.trim();
  if (explicit) {
    const vectors = await requestEmbeddingBatch(sample, explicit, purpose);
    cachedModel = explicit;
    cachedAt = Date.now();
    return { model: explicit, vectors };
  }

  const candidates = await discoverCandidates(false);
  const ordered = cachedModel
    ? [cachedModel, ...candidates.filter((x) => x !== cachedModel)]
    : candidates;

  let lastError = null;

  for (const model of ordered.slice(0, 12)) {
    try {
      const vectors = await requestEmbeddingBatch(sample, model, purpose);
      cachedModel = model;
      cachedAt = Date.now();
      return { model, vectors };
    } catch (error) {
      lastError = error;
      if (![400, 404, 422].includes(error?.status)) break;
    }
  }

  if (!ordered.length) {
    try {
      const vectors = await requestEmbeddingBatch(sample, null, purpose);
      cachedModel = null;
      return { model: null, vectors };
    } catch (error) {
      lastError = error;
    }
  }

  const finalError = new Error(lastError?.message || "embedding_model_unresolved");
  finalError.detail = lastError?.detail || null;
  throw finalError;
}

export async function embedTexts(texts, options = {}) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], model: null };
  }

  const purpose = options.purpose === "query" ? "query" : "passage";
  const firstBatch = texts.slice(0, 32);
  const selected = await chooseWorkingModel(firstBatch, purpose);

  const vectors = [...selected.vectors];
  const model = selected.model;

  for (let i = 32; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    vectors.push(...await requestEmbeddingBatch(batch, model, purpose));
  }

  if (vectors.length !== texts.length) {
    throw new Error("embedding_count_mismatch");
  }

  return { vectors, model };
}

export async function embedQuery(text) {
  const { vectors, model } = await embedTexts([text], { purpose: "query" });
  return { vector: vectors[0], model };
}

export function embeddingDiagnostics() {
  try {
    const ep = endpoints();
    return {
      configured: Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY),
      embeddingsEndpoint: new URL(ep.embeddings).origin,
      dynamicModel: !Boolean(process.env.EMBEDDING_MODEL),
      activeModel: cachedModel
    };
  } catch {
    return { configured: false, dynamicModel: true, activeModel: null };
  }
}
