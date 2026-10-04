import { embedQuery } from "./embedding.js";
import { recentChunks } from "./storage.js";

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = Number(a[i]) || 0;
    const y = Number(b[i]) || 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  if (!aa || !bb) return -1;
  return dot / (Math.sqrt(aa) * Math.sqrt(bb));
}

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
  const candidateLimit = Math.max(100, Math.min(Number(options.candidateLimit || 1500), 5000));
  const perDocument = Math.max(1, Math.min(Number(options.perDocument || 2), 5));

  const urls = Array.isArray(options.urls) ? options.urls.filter(Boolean) : null;
  const [{ vector, model }, candidates] = await Promise.all([
    embedQuery(q),
    recentChunks(candidateLimit, urls)
  ]);

  const qTerms = terms(q);
  const scored = candidates
    .map((row) => {
      const semantic = cosine(vector, row.embedding);
      const lexical = lexicalScore(qTerms, row);
      const normalizedSemantic = semantic < -0.99 ? 0 : (semantic + 1) / 2;
      const score = normalizedSemantic * 0.85 + lexical * 0.15;
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
    candidateCount: candidates.length,
    results
  };
}
