import { embedQuery } from "./embedding.js";
import { recentChunks, vectorSearchChunks } from "./storage.js";

function terms(text = "") {
  return [...new Set(
    String(text)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{1,}/g) || []
  )].filter((x) => x.length > 2);
}

function lexicalScore(queryTerms, row) {
  if (!queryTerms.length) return 0;
  const haystack = `${row.title || ""} ${row.text || ""}`.toLowerCase();
  let hits = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) hits++;
  }
  return hits / queryTerms.length;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) {
    return null;
  }

  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]);
    const y = Number(b[i]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }

  if (!aa || !bb) return null;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

function mergeFreshCandidates(atlasCandidates, freshRows, queryVector, model) {
  const byChunk = new Map();
  for (const row of atlasCandidates || []) {
    byChunk.set(`${row.documentId}:${row.ordinal}`, row);
  }

  let added = 0;
  for (const row of freshRows || []) {
    if (
      model &&
      row.embeddingModel &&
      row.embeddingModel !== model
    ) {
      continue;
    }

    const cosine = cosineSimilarity(queryVector, row.embedding);
    if (cosine == null) continue;
    const key = `${row.documentId}:${row.ordinal}`;
    if (byChunk.has(key)) continue;

    byChunk.set(key, {
      ...row,
      vectorScore: Math.max(0, Math.min(1, (cosine + 1) / 2))
    });
    added++;
  }

  return { candidates: [...byChunk.values()], added };
}

export async function searchIndex(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query_required");

  const limit = Math.max(1, Math.min(Number(options.limit || 5), 20));
  const candidateLimit = Math.max(
    limit,
    Math.min(Number(options.candidateLimit || Math.max(limit * 20, 100)), 500)
  );
  const perDocument = Math.max(1, Math.min(Number(options.perDocument || 2), 5));
  const urls = Array.isArray(options.urls) ? options.urls.filter(Boolean) : null;

  const { vector, model } = await embedQuery(q);
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error("query_embedding_missing");
  }

  let atlasCandidates = [];
  let atlasOk = true;
  try {
    atlasCandidates = await vectorSearchChunks(vector, {
      limit: candidateLimit,
      numCandidates: Math.min(Math.max(candidateLimit * 20, 100), 10000),
      urls,
      embeddingModel: model
    });
  } catch {
    atlasOk = false;
  }

  let candidates = atlasCandidates;
  let localAdded = 0;

  if (urls?.length || !atlasOk) {
    const freshRows = await recentChunks(candidateLimit, urls);
    const merged = mergeFreshCandidates(atlasCandidates, freshRows, vector, model);
    candidates = merged.candidates;
    localAdded = merged.added;
  }

  if (!candidates.length && !atlasOk) {
    throw new Error("vector_retrieval_unavailable");
  }

  const qTerms = terms(q);
  const scored = candidates
    .map((row) => {
      const vectorScore = Number(row.vectorScore) || 0;
      const semantic = vectorScore * 2 - 1;
      const lexical = lexicalScore(qTerms, row);
      const score = vectorScore * 0.85 + lexical * 0.15;
      return {
        ...row,
        score,
        semanticScore: semantic,
        lexicalScore: lexical
      };
    })
    .sort((a, b) => b.score - a.score);

  const results = [];
  const perDocumentCounts = new Map();

  for (const row of scored) {
    const used = perDocumentCounts.get(row.documentId) || 0;
    if (used >= perDocument) continue;
    perDocumentCounts.set(row.documentId, used + 1);

    results.push({
      title: row.title,
      url: row.url,
      content: row.text,
      score: Number(row.score.toFixed(6)),
      semanticScore: Number(row.semanticScore.toFixed(6)),
      lexicalScore: Number(row.lexicalScore.toFixed(6)),
      chunk: row.ordinal,
      crawledAt: row.crawledAt
    });

    if (results.length >= limit) break;
  }

  return {
    query: q,
    embeddingModel: model,
    retrieval: atlasOk
      ? (localAdded ? "atlas-vector+local-fresh" : "atlas-vector")
      : "local-vector-fallback",
    vectorIndex: process.env.VECTOR_INDEX_NAME?.trim() || "chunks_embedding_v2",
    candidateCount: candidates.length,
    results
  };
}
