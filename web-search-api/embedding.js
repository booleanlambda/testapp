let cachedModel = null;
let cachedAt = 0;

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
  if (/\b(bge|e5|gte|nomic|jina)\b/.test(s)) score += 70;
  if (/small|mini|base/.test(s)) score += 10;
  if (/rerank|chat|instruct|vision|audio/.test(s)) score -= 80;
  return score;
}

export async function resolveEmbeddingModel(force = false) {
  const explicit = process.env.EMBEDDING_MODEL?.trim();
  if (explicit) return explicit;

  if (!force && cachedModel && Date.now() - cachedAt < 60 * 60 * 1000) {
    return cachedModel;
  }

  const { models } = endpoints();
  try {
    const response = await fetch(models, { headers: headers(), signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const json = await response.json();
      const ids = Array.isArray(json?.data)
        ? json.data.map((x) => x?.id).filter(Boolean)
        : [];
      const ranked = ids
        .map((id) => ({ id, score: scoreModel(id) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (ranked.length) {
        cachedModel = ranked[0].id;
        cachedAt = Date.now();
        return cachedModel;
      }
    }
  } catch {}

  return null;
}

async function requestEmbeddingBatch(input, model) {
  const { embeddings } = endpoints();
  const body = { input };
  if (model) body.model = model;

  const response = await fetch(embeddings, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const message = (await response.text().catch(() => "")).slice(0, 500);
    const error = new Error(`embedding_request_failed_${response.status}`);
    error.detail = message;
    throw error;
  }

  const json = await response.json();
  const rows = Array.isArray(json?.data) ? json.data : [];
  if (!rows.length) throw new Error("embedding_response_empty");
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return rows.map((row) => row.embedding).filter(Array.isArray);
}

export async function embedTexts(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { vectors: [], model: null };
  }

  let model = await resolveEmbeddingModel();
  const vectors = [];

  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    try {
      vectors.push(...await requestEmbeddingBatch(batch, model));
    } catch (error) {
      if (!process.env.EMBEDDING_MODEL && model) {
        model = await resolveEmbeddingModel(true);
      }
      throw error;
    }
  }

  if (vectors.length !== texts.length) {
    throw new Error("embedding_count_mismatch");
  }

  return { vectors, model };
}

export async function embedQuery(text) {
  const { vectors, model } = await embedTexts([text]);
  return { vector: vectors[0], model };
}

export function embeddingDiagnostics() {
  try {
    const ep = endpoints();
    return {
      configured: Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY),
      embeddingsEndpoint: new URL(ep.embeddings).origin,
      dynamicModel: !Boolean(process.env.EMBEDDING_MODEL)
    };
  } catch {
    return { configured: false, dynamicModel: true };
  }
}
