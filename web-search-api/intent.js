const STOP = new Set([
  "a","an","and","are","as","at","be","by","for","from","how","in","is","it","of",
  "on","or","that","the","this","to","what","when","where","which","who","why","with",
  "latest","recent","news","today","update","updates","best","top","biggest"
]);

const GENERIC_TECH = new Set([
  "ai","api","app","apps","tool","tools","software","system","systems","platform",
  "service","services","web","online","agent","agents"
]);

const GENERIC_PRECISION = new Set([
  "best","top","biggest","open","source","alternative","alternatives","compare","comparison",
  "versus","documentation","docs","tutorial","guide","official","community","developer",
  "implementation","latest","recent","news","today","update","updates","decision",
  "october","september","august","july","june","may","april","march","february","january",
  "november","december","search","policy","rate","bank"
]);

const MONTHS = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
const FINANCE_SIGNAL = /\b(cedi|currency|fx|forex|economy|economic|inflation|market|markets|rates?|policy rate|central bank|bank of ghana|gdp|debt|bonds?|reserves?|import cover|dollar|usd)\b/i;
const EVENT_SIGNAL = /\b(devday|conference|event|keynote|launch|launched|release|released|announcement|announcements|unveil|unveiled|introduce|introduced)\b/i;

function words(q) {
  return String(q).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [];
}

function rawWords(q) {
  return String(q).match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || [];
}

function uniq(xs) {
  return [...new Set(xs)];
}

function currentOrRecentYear(q) {
  const current = new Date().getUTCFullYear();
  const years = [...String(q).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  return years.some((year) => year >= current - 1 && year <= current + 1);
}

function inferBrand(q, content) {
  const raws = rawWords(q);
  for (const token of raws) {
    if (/[a-z][A-Z]|[A-Z].*[A-Z]/.test(token) && token.length >= 5) {
      return token.toLowerCase();
    }
  }

  const alt = String(q).match(/\balternatives?\s+to\s+([A-Za-z0-9._-]+)/i);
  if (alt?.[1]) return alt[1].toLowerCase();

  return content.find((t) =>
    t.length >= 5 &&
    !GENERIC_PRECISION.has(t) &&
    !GENERIC_TECH.has(t) &&
    !/^20\d{2}$/.test(t)
  ) || null;
}

export function analyzeQuery(query) {
  const q = String(query || "").trim();
  const tokens = words(q);
  const year = new Date().getUTCFullYear();

  const explicitNews = /\b(news|latest|today|breaking|recent|update|updates|this week|this month)\b/i.test(q);
  const hasRecentYear = currentOrRecentYear(q);
  const dated = new RegExp(`\\b${MONTHS}\\b(?:\\s+\\d{1,2})?(?:,)?\\s+20\\d{2}|\\b20\\d{2}\\b`, "i").test(q);
  const temporalFinance = hasRecentYear && dated && FINANCE_SIGNAL.test(q);
  const temporalEvent = hasRecentYear && EVENT_SIGNAL.test(q);

  const news = explicitNews || temporalFinance || temporalEvent;
  const tutorial = /\b(tutorial|guide|how to|example|examples|docs|documentation|learn|setup|install|implementation)\b/i.test(q);
  const technical = /\b(api|sdk|code|developer|programming|crawler|scraper|vector|embedding|database|agent|agents|rag|llm|github|npm|python|javascript|mongodb|mongot|playwright)\b/i.test(q);
  const comparison = /\b(alternative|alternatives|compare|comparison|versus|\bvs\.?\b|replacement|competitor|competitors)\b/i.test(q);
  const commercial = /\b(price|pricing|cost|buy|product|vendor|provider)\b/i.test(q);

  let intent = "general";
  if (news) intent = "news";
  else if (comparison && technical) intent = "technical_comparison";
  else if (tutorial && technical) intent = "technical_tutorial";
  else if (technical) intent = "technical";
  else if (comparison || commercial) intent = "commercial";

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

  const precisionAnchors = uniq(anchors.filter((t) =>
    !GENERIC_PRECISION.has(t) &&
    !GENERIC_TECH.has(t) &&
    !/^20\d{2}$/.test(t)
  )).slice(0, 5);

  const phrases = [];
  const lower = q.toLowerCase();
  if (/web\s+crawler/.test(lower)) phrases.push("web crawler");
  if (/web\s+search\s+api/.test(lower)) phrases.push("web search api");
  else if (/search\s+api/.test(lower)) phrases.push("search api");
  if (/open\s+source/.test(lower)) phrases.push("open source");
  if (/vector\s+search/.test(lower)) phrases.push("vector search");
  if (/ai\s+agent/.test(lower)) phrases.push("ai agent");
  if (/ghana\s+cedi/.test(lower)) phrases.push("ghana cedi");
  if (/bank\s+of\s+ghana/.test(lower)) phrases.push("bank of ghana");
  if (/import\s+cover/.test(lower)) phrases.push("import cover");
  if (/policy\s+rate/.test(lower)) phrases.push("policy rate");
  if (/openai\s+devday/.test(lower)) phrases.push("openai devday");
  if (/\bagents?\b/.test(lower) && /\bcrawler|search|retrieval|rag\b/.test(lower)) phrases.push("agent");

  const brand = inferBrand(q, content);
  const comparisonTarget = String(q).match(/\balternatives?\s+to\s+([A-Za-z0-9._-]+)/i)?.[1]?.toLowerCase() || null;
  const comparisonMode = /\b(alternative|alternatives|replacement|competitor|competitors)\b/i.test(q)
    ? "alternatives"
    : comparison
      ? "comparison"
      : null;

  const variants = [q];

  if (intent === "news") {
    const base = q
      .replace(/\b(latest|recent|breaking|today|news|updates?)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();

    variants.push(`${base} latest news ${year}`);

    if (FINANCE_SIGNAL.test(q)) {
      variants.push(`${base} economy market central bank reserves ${year}`);
    } else {
      variants.push(`${base} announcements developments ${year}`);
    }
  } else if (intent === "technical_tutorial" || intent === "technical") {
    const precise = precisionAnchors.slice(0, 3).map((p) => `"${p}"`).join(" ");
    const quoted = phrases.filter((p) => p !== "agent").slice(0, 2).map((p) => `"${p}"`).join(" ");
    const suffix = intent === "technical_tutorial"
      ? "official documentation tutorial implementation"
      : "developer documentation open source implementation";

    variants.push(`${precise} ${quoted} ${suffix}`.replace(/\s+/g, " ").trim());

    if (brand && precisionAnchors.length >= 2) {
      variants.push(`site:${brand}.com ${precise} ${quoted} official documentation`.replace(/\s+/g, " ").trim());
    } else if (/\bagents?\b/i.test(q) && /\bcrawler|search|retrieval|rag\b/i.test(q)) {
      variants.push(`"web crawler" agents retrieval RAG search open source`);
    }
  } else if (intent === "technical_comparison") {
    const cleaned = q
      .replace(/\b(best|top|leading)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const target = comparisonTarget || precisionAnchors[0] || brand;

    if (target && comparisonMode === "alternatives") {
      variants[0] = `site:github.com "${target}" alternative open source`;
      variants.push(`"${target}" "open source alternative" "web search api"`);
      variants.push(`"${target}" replacement self-hosted web search`);
    } else if (target) {
      variants[0] = cleaned;
      variants.push(`"${target}" comparison "web search api" agents`);
      variants.push(`"${target}" versus competitor search API`);
    } else {
      variants[0] = cleaned;
      variants.push(`${cleaned} alternatives comparison open source`);
    }
  } else if (intent === "commercial") {
    variants.push(`${q.replace(/\b(best|top)\b/gi, " ")} pricing alternatives comparison`.replace(/\s+/g, " ").trim());
  }

  const strictPrecision =
    intent === "technical_tutorial" ||
    intent === "technical_comparison" ||
    (intent === "technical" && precisionAnchors.length >= 2);

  return {
    intent,
    anchors: uniq(anchors).slice(0, 8),
    precisionAnchors,
    phrases: uniq(phrases),
    brand,
    comparisonTarget,
    comparisonMode,
    strictPrecision,
    variants: uniq(variants.filter(Boolean)).slice(0, 3)
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
  let precisionHits = 0;

  for (const anchor of analysis.anchors) {
    const hit = countOccurrences(hay, anchor.toLowerCase());
    if (hit) {
      anchorHits++;
      score += Math.min(3, hit) * 1.6;
    }
  }

  for (const anchor of analysis.precisionAnchors || []) {
    if (hay.includes(anchor.toLowerCase())) {
      precisionHits++;
      score += 4;
    }
  }

  for (const phrase of analysis.phrases) {
    if (hay.includes(phrase)) score += 5;
  }

  if (analysis.intent === "news") {
    if (/news|reuters|bloomberg|cnbc|finance|business|economy|market|central bank|bank of ghana|monetary policy/.test(hay)) score += 2;
    if (/wikipedia|britannica|worldatlas|countryreports/.test(hay)) score -= 8;
  }

  if (analysis.intent.startsWith("technical")) {
    if (/docs|documentation|github|developer|tutorial|guide|api|sdk|open source|implementation/.test(hay)) score += 2;
    if (/gemini.google.com|chatgpt.com|bestbuy|merriam-webster|wordreference|thefreedictionary/.test(hay)) score -= 12;
  }

  if (analysis.intent === "technical_comparison") {
    if (/alternative|alternatives|competitor|competitors|comparison|versus|\bvs\b/.test(hay)) score += 4;
    if (analysis.comparisonTarget && hay.includes(analysis.comparisonTarget)) score += 5;
  }

  const needed = Math.min(2, analysis.anchors.length);
  if (needed > 0 && anchorHits === 0) score -= 8;
  else if (needed > 1 && anchorHits < needed) score -= 2;

  if ((analysis.precisionAnchors || []).length) {
    if (precisionHits === 0) score -= 12;
    else if (analysis.strictPrecision && precisionHits < Math.min(2, analysis.precisionAnchors.length)) score -= 6;
  }

  if (analysis.brand) {
    try {
      const host = new URL(row.url).hostname.toLowerCase();
      if (host.includes(analysis.brand)) score += 3;
    } catch {}
  }

  score += Math.max(0, 3 - Number(row.rank || 99) * 0.15);
  return score;
}

export function passesPrecision(row, analysis) {
  if (!analysis.strictPrecision || !(analysis.precisionAnchors || []).length) return true;

  const hay = `${row.title || ""} ${row.snippet || ""} ${row.url || ""}`.toLowerCase();
  const hits = analysis.precisionAnchors.filter((a) => hay.includes(a.toLowerCase())).length;
  const required = Math.min(2, analysis.precisionAnchors.length);

  if (row.provider === "official-sitemap" && analysis.brand) {
    try {
      const host = new URL(row.url).hostname.toLowerCase();
      if (host.includes(analysis.brand)) return true;
    } catch {}
  }

  if (analysis.intent === "technical_comparison" && analysis.comparisonTarget) {
    const mentionsTarget = hay.includes(analysis.comparisonTarget);
    const alternativeSignal = /alternative|alternatives|replacement|competitor|competitors/.test(hay);
    const comparisonSignal = alternativeSignal || /comparison|versus|\bvs\b/.test(hay);
    const categorySignal = /web search|search api|open source|self-hosted|agent|rag|crawler/.test(hay);

    if (analysis.comparisonMode === "alternatives") {
      return alternativeSignal && categorySignal;
    }

    if (mentionsTarget) return comparisonSignal && categorySignal;
    return comparisonSignal && categorySignal;
  }

  return hits >= required;
}
