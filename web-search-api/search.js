import { embedQuery } from "./embedding.js";
import { vectorSearchChunks } from "./storage.js";

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

  const candidates = await vectorSearchChunks(vector, {
    limit: candidateLimit,
    numCandidates: Math.min(Math.max(candidateLimit * 20, 100), 10000),
    urls,
    embeddingModel: model
  });

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
    retrieval: "atlas-vector",
    vectorIndex: process.env.VECTOR_INDEX_NAME?.trim() || "chunks_embedding_v2",
    candidateCount: candidates.length,
    results
  };
}
