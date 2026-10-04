const STOP = new Set([
  "a","an","and","are","as","at","be","by","for","from","how","in","is","it","of",
  "on","or","that","the","this","to","what","when","where","which","who","why","with",
  "latest","recent","news","today","update","updates"
]);

const GENERIC_TECH = new Set([
  "ai","api","app","apps","tool","tools","software","system","systems","platform",
  "service","services","web","online","agent","agents"
]);

function words(q) {
  return (String(q).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || []);
}

function uniq(xs) {
  return [...new Set(xs)];
}

export function analyzeQuery(query) {
  const q = String(query || "").trim();
  const tokens = words(q);

  const news = /\b(news|latest|today|breaking|recent|update|updates|this week|this month)\b/i.test(q);
  const tutorial = /\b(tutorial|guide|how to|example|examples|docs|documentation|learn|setup|install|implementation)\b/i.test(q);
  const technical = /\b(api|sdk|code|developer|programming|crawler|scraper|vector|embedding|database|agent|agents|rag|llm|github|npm|python|javascript|mongodb)\b/i.test(q);
  const commercial = /\b(price|pricing|cost|buy|product|vendor|provider|alternative|alternatives|compare|comparison)\b/i.test(q);

  let intent = "general";
  if (news) intent = "news";
  else if (tutorial && technical) intent = "technical_tutorial";
  else if (technical) intent = "technical";
  else if (commercial) intent = "commercial";

  const content = tokens.filter((t) => !STOP.has(t));
  const anchors = uniq(content.filter((t) => {
    if (t.length < 4) return false;
    if (GENERIC_TECH.has(t)) return false;
    return true;
  }));

  if (!anchors.length && technical) {
    for (const t of content) {
      if (t.length >= 4 && !["tool","tools","software","system","platform"].includes(t)) anchors.push(t);
    }
  }

  const phrases = [];
  const lower = q.toLowerCase();
  if (/web\s+crawler/.test(lower)) phrases.push("web crawler");
  if (/vector\s+search/.test(lower)) phrases.push("vector search");
  if (/search\s+api/.test(lower)) phrases.push("search api");
  if (/ai\s+agent/.test(lower)) phrases.push("ai agent");
  if (/ghana\s+cedi/.test(lower)) phrases.push("ghana cedi");

  const year = new Date().getUTCFullYear();
  const variants = [q];

  if (intent === "news") {
    const base = q
      .replace(/\b(latest|recent|breaking|today|news|updates?)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    variants.push(`${base} latest news ${year}`);
    variants.push(`${base} economy market central bank ${year}`);
  } else if (intent === "technical" || intent === "technical_tutorial") {
    const quoted = phrases.length
      ? phrases.map((p) => `"${p}"`).join(" ")
      : anchors.slice(0, 3).map((p) => `"${p}"`).join(" ");
    const suffix = intent === "technical_tutorial"
      ? "documentation tutorial implementation"
      : "developer documentation open source implementation";
    variants.push(`${quoted || q} ${suffix}`.trim());

    if (/\bagents?\b/i.test(q) && /\bcrawler|search|retrieval|rag\b/i.test(q)) {
      variants.push(`"web crawler" agents retrieval RAG search open source`);
    }
  } else if (intent === "commercial") {
    variants.push(`${q} pricing alternatives comparison`);
  }

  return {
    intent,
    anchors: uniq(anchors).slice(0, 8),
    phrases: uniq(phrases),
    variants: uniq(variants).slice(0, 3)
  };
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) >= 0) {
    n++;
    i += needle.length;
  }
  return n;
}

export function relevanceScore(row, analysis) {
  const hay = `${row.title || ""} ${row.snippet || ""} ${row.url || ""}`.toLowerCase();

  let score = 0;
  let anchorHits = 0;

  for (const anchor of analysis.anchors) {
    const hit = countOccurrences(hay, anchor.toLowerCase());
    if (hit) {
      anchorHits++;
      score += Math.min(3, hit) * 2.2;
    }
  }

  for (const phrase of analysis.phrases) {
    if (hay.includes(phrase)) score += 5;
  }

  if (analysis.intent === "news") {
    if (/news|reuters|bloomberg|cnbc|finance|business|economy|market|central bank|bank of ghana/.test(hay)) score += 2;
    if (/wikipedia|britannica|worldatlas/.test(hay)) score -= 5;
  }

  if (analysis.intent.startsWith("technical")) {
    if (/docs|documentation|github|developer|tutorial|guide|api|sdk|open source|implementation/.test(hay)) score += 2;
    if (/gemini.google.com|chatgpt.com/.test(hay)) score -= 4;
  }

  const needed = Math.min(2, analysis.anchors.length);
  if (needed > 0 && anchorHits === 0) score -= 8;
  else if (needed > 1 && anchorHits < needed) score -= 2;

  score += Math.max(0, 3 - Number(row.rank || 99) * 0.15);
  return score;
}
