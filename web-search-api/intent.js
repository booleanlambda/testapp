const STOP = new Set([
  "a","an","and","are","as","at","be","by","for","from","how","in","is","it","of",
  "on","or","that","the","this","to","what","when","where","which","who","why","with",
  "do","does","did","done","can","could","should","would","will","may","might","must",
  "have","has","had","latest","recent","news","today","update","updates","best","top","biggest"
]);

const GENERIC_TECH = new Set([
  "ai","api","app","apps","tool","tools","software","system","systems","platform",
  "service","services","web","online","agent","agents"
]);

const GENERIC_PRECISION = new Set([
  "best","top","biggest","open","source","alternative","alternatives","compare","comparison",
  "versus","documentation","docs","tutorial","guide","official","community","developer",
  "implementation","latest","recent","news","today","update","updates","decision",
  "tune","tuning","tradeoff","tradeoffs","differ","difference","differences","affect","affects",
  "write","writes","writing","written","image","images","after","before","change","changes",
  "trigger","triggers","triggered","them","then","also","using","used","work","works",
  "october","september","august","july","june","may","april","march","february","january",
  "november","december","search","policy","rate","bank"
]);

const MONTHS = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
const FINANCE_SIGNAL = /\b(cedi|currency|fx|forex|economy|economic|inflation|market|markets|rates?|policy rate|central bank|bank of ghana|gdp|debt|bonds?|reserves?|import cover|dollar|usd)\b/i;
const EVENT_SIGNAL = /\b(devday|conference|event|keynote|launch|launched|release|released|announcement|announcements|unveil|unveiled|introduce|introduced)\b/i;

function words(q) {
  return (String(q).toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) || [])
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
    .filter(Boolean);
}

function rawWords(q) {
  return (String(q).match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) || [])
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
    .filter(Boolean);
}

function uniq(xs) {
  return [...new Set(xs)];
}

const PHRASE_CONNECTORS = new Set([
  "with","without","of","for","in","on","at","by","from","to","near","around",
  "inside","outside","under","over","between","among","through","across"
]);

const PHRASE_DETERMINERS = new Set(["a","an","the","this","that","these","those"]);

const GENERIC_SHORT_ANCHORS = new Set([
  "new","old","one","two","use","used","get","got","see","saw","say","way",
  "via","per","etc","now","out","off","all","any","our","your"
]);

function phraseHasConnector(phrase) {
  return words(phrase).some((token) => PHRASE_CONNECTORS.has(token));
}

function explicitQuotedPhrases(query) {
  const phrases = [];
  for (const match of String(query).matchAll(/["“”]([^"“”]{3,120})["“”]/g)) {
    const normalized = normalizePhraseText(match[1]);
    if (normalized) phrases.push(normalized);
  }
  return uniq(phrases);
}

function entityPhraseCandidates(query, queryPhrases) {
  const quoted = explicitQuotedPhrases(query);
  const inferred = (queryPhrases || []).filter((phrase) => !phraseHasConnector(phrase));
  return uniq([...quoted, ...inferred]).slice(0, 6);
}

function relationalAnchorVariant(descriptivePhrases, anchors) {
  const phrase = (descriptivePhrases || [])[0];
  if (!phrase) return null;

  const tokens = words(phrase);
  const connectorIndex = tokens.findIndex((token) => PHRASE_CONNECTORS.has(token));
  if (connectorIndex <= 0 || connectorIndex >= tokens.length - 1) return null;

  let leftIndex = connectorIndex - 1;
  while (leftIndex >= 0 && (STOP.has(tokens[leftIndex]) || PHRASE_DETERMINERS.has(tokens[leftIndex]))) {
    leftIndex -= 1;
  }

  let rightIndex = connectorIndex + 1;
  while (rightIndex < tokens.length && (STOP.has(tokens[rightIndex]) || PHRASE_DETERMINERS.has(tokens[rightIndex]))) {
    rightIndex += 1;
  }

  if (leftIndex < 0 || rightIndex >= tokens.length) return null;

  const left = tokens[leftIndex];
  const right = tokens[rightIndex];
  const consumed = new Set([left, right]);

  const remainder = (anchors || [])
    .filter((token) => !consumed.has(token))
    .slice(0, 4);

  return [
    `"${left}"`,
    `"${right}"`,
    ...remainder
  ].join(" ").trim();
}

function normalizePhraseText(value) {
  return words(value).join(" ").trim();
}

function likelyClauseVerb(token, nextToken = "") {
  const t = String(token || "").toLowerCase();
  const next = String(nextToken || "").toLowerCase();

  if ([
    "is","are","was","were","be","been","being","has","have","had",
    "do","does","did","can","could","will","would","may","might","must",
    "turn","turns","turned","take","takes","took","make","makes","made",
    "say","says","said","go","goes","went","find","finds","found",
    "see","sees","saw","get","gets","got","give","gives","gave",
    "show","shows","showed","cause","causes","caused","become","becomes","became"
  ].includes(t)) return true;

  // A third-person-looking action immediately followed by a determiner
  // is a strong clause boundary: "beard turns the guy", "shirt covers a box".
  return t.length > 4 && t.endsWith("s") && PHRASE_DETERMINERS.has(next);
}

function queryPhraseCandidates(query) {
  const scored = new Map();

  const add = (value, score) => {
    const phrase = normalizePhraseText(value);
    if (!phrase || phrase.split(/\s+/).length < 2) return;
    const current = scored.get(phrase);
    if (current == null || score > current) scored.set(phrase, score);
  };

  // Preserve explicit user quoting above all inferred phrase structure.
  for (const match of String(query).matchAll(/["“”]([^"“”]{3,120})["“”]/g)) {
    add(match[1], 100);
  }

  // Capitalized multiword names/entities are strong phrase signals.
  for (const clause of String(query).split(/[.!?;:,]+/)) {
    const raw = rawWords(clause);
    let run = [];

    const flush = () => {
      if (run.length >= 2) {
        add(run.slice(0, 5).join(" "), 80 + Math.min(run.length, 5));
      }
      run = [];
    };

    for (const token of raw) {
      const lower = token.toLowerCase();
      const titleLike =
        /^[A-Z][A-Za-z0-9._-]*$/.test(token) &&
        !PHRASE_DETERMINERS.has(lower) &&
        !STOP.has(lower);

      if (titleLike) run.push(token);
      else flush();
    }
    flush();
  }

  // Keep grammatical connectors inside a bounded phrase instead of throwing
  // them away. Example: "the guy with a beard turns the guy" ->
  // "guy with a beard", not merely "beard turns".
  for (const clause of String(query).split(/[.!?;:,]+/)) {
    const tokens = words(clause);

    for (let i = 1; i < tokens.length - 1; i += 1) {
      if (!PHRASE_CONNECTORS.has(tokens[i])) continue;

      const left = tokens[i - 1];
      if (!left || STOP.has(left)) continue;

      let right = i + 1;
      while (right < tokens.length && PHRASE_DETERMINERS.has(tokens[right])) {
        right += 1;
      }
      if (right >= tokens.length || STOP.has(tokens[right])) continue;

      const baseStart =
        i >= 2 && !STOP.has(tokens[i - 2]) && tokens[i - 2].length >= 3
          ? i - 2
          : i - 1;

      // Minimal attachment reaches the first content word after the connector.
      add(tokens.slice(i - 1, right + 1).join(" "), 65);
      if (baseStart < i - 1) {
        add(tokens.slice(baseStart, right + 1).join(" "), 67);
      }

      // One-word right expansion captures adjective+noun objects such as
      // "guy with a long beard", but stops before a likely new clause.
      const expanded = right + 1;
      if (
        expanded < tokens.length &&
        !STOP.has(tokens[expanded]) &&
        !likelyClauseVerb(tokens[expanded], tokens[expanded + 1])
      ) {
        add(tokens.slice(i - 1, expanded + 1).join(" "), 70);
        if (baseStart < i - 1) {
          add(tokens.slice(baseStart, expanded + 1).join(" "), 72);
        }
      }
    }
  }

  // Retain the original conservative adjacent-content fallback.
  const tokens = words(query);
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i];
    const b = tokens[i + 1];
    if (STOP.has(a) || STOP.has(b)) continue;
    if (a.length < 4 || b.length < 4) continue;
    if (likelyClauseVerb(b, tokens[i + 2])) continue;
    add(`${a} ${b}`, 30);
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].split(/\s+/).length - a[0].split(/\s+/).length)
    .map(([phrase]) => phrase)
    .slice(0, 6);
}

function quotedCoreVariant(query, phrases, anchors) {
  const core = phrases?.[0];
  if (!core) return null;

  const coreTokens = new Set(core.split(/\s+/));
  const remainder = (anchors || [])
    .filter((token) => !coreTokens.has(token))
    .slice(0, 5)
    .join(" ");

  return `"${core}" ${remainder}`.replace(/\s+/g, " ").trim();
}

function currentOrRecentYear(q) {
  const current = new Date().getUTCFullYear();
  const years = [...String(q).matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  return years.some((year) => year >= current - 1 && year <= current + 1);
}

function inferBrand(q, content) {
  const raws = rawWords(q);
  const nonBrandTechnicalTokens = new Set([
    "managedfields",
    "managedfield",
    "serverside",
    "clientside",
    "server-side",
    "client-side"
  ]);

  const technicalContext = /\b(api|sdk|code|developer|programming|javascript|node(?:\.js)?|nodejs|python|runtime|event loop|microtask|callback|database|kubernetes|postgres|mongodb)\b/i.test(q);

  for (const token of raws) {
    const lowerToken = token.toLowerCase();
    const codeLikeIdentifier =
      token.includes(".") ||
      token.includes("_") ||
      (technicalContext && /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/.test(token));

    // Mixed/title-case product names can be useful brands, but code identifiers are not.
    // This prevents rewrites such as site:process.nexttick.com or site:queuemicrotask.com.
    if (
      !token.includes("-") &&
      !codeLikeIdentifier &&
      !nonBrandTechnicalTokens.has(lowerToken) &&
      /[a-z][A-Z]|[A-Z].*[A-Z]/.test(token) &&
      token.length >= 5
    ) {
      return lowerToken;
    }
  }

  const alt = String(q).match(/\balternatives?\s+to\s+([A-Za-z0-9._-]+)/i);
  if (alt?.[1]) return alt[1].toLowerCase();

  if (!/\b(official|documentation|docs|website|site)\b/i.test(q)) return null;

  return content.find((t) =>
    t.length >= 5 &&
    !GENERIC_PRECISION.has(t) &&
    !GENERIC_TECH.has(t) &&
    !["pgvector","hnsw","ivfflat","ef_construction"].includes(t) &&
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
  const technical = /\b(api|sdk|code|developer|programming|crawler|scraper|vector|embedding|database|agent|agents|rag|llm|github|npm|python|javascript|node|node\.js|nodejs|process\.nexttick|queuemicrotask|setimmediate|settimeout|setinterval|event loop|microtask|macrotask|libuv|async_hooks|worker_threads|mongodb|mongot|playwright|pgvector|postgres|postgresql|hnsw|ivfflat|ef_construction|kubernetes|k8s|managedfields|managed-fields|server-side|serverside)\b/i.test(q) || /server[- ]side\s+apply/i.test(q);
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
    if (t.length < 3) return false;
    if (t.length === 3 && GENERIC_SHORT_ANCHORS.has(t)) return false;
    if (GENERIC_TECH.has(t)) return false;
    return true;
  }));

  if (!anchors.length && technical) {
    for (const t of content) {
      if (t.length >= 4 && !["tool","tools","software","system","platform"].includes(t)) anchors.push(t);
    }
  }

  const precisionCandidates = uniq(anchors.filter((t) =>
    !GENERIC_PRECISION.has(t) &&
    !GENERIC_TECH.has(t) &&
    !/^20\d{2}$/.test(t)
  ));

  const systemTerms = /^(node|node\.js|nodejs|process\.nexttick|queuemicrotask|setimmediate|settimeout|setinterval|event|loop|microtask|microtasks|macrotask|macrotasks|libuv|async_hooks|worker_threads|postgres|postgresql|mongodb|mongot|pgvector|hnsw|ivfflat|checkpoint|checkpoints|wal|wal_compression|full-page|hint|bits|replication|vacuum|btree|lsn|mvcc|redo|undo|kubernetes|k8s|server-side|managedfields|managed-fields|conflict|conflicts|force)$/;

  const precisionAnchors = precisionCandidates
    .map((token, index) => {
      let priority = 0;
      if (token.includes("_")) priority += 12;
      if (token.includes(".")) priority += 10;
      if (token.includes("-")) priority += 7;
      if (systemTerms.test(token)) priority += 9;
      if (token.length >= 9) priority += 3;
      else if (token.length >= 6) priority += 1;
      return { token, index, priority };
    })
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .slice(0, 5)
    .map((x) => x.token);

  const phrases = [];
  const queryPhrases = queryPhraseCandidates(q);
  const entityPhrases = entityPhraseCandidates(q, queryPhrases);
  const descriptivePhrases = queryPhrases.filter((phrase) => phraseHasConnector(phrase));
  const lower = q.toLowerCase();
  if (/web\s+crawler/.test(lower)) phrases.push("web crawler");
  if (/web\s+search\s+api/.test(lower)) phrases.push("web search api");
  else if (/search\s+api/.test(lower)) phrases.push("search api");
  if (/open\s+source/.test(lower)) phrases.push("open source");
  if (/vector\s+search/.test(lower)) phrases.push("vector search");
  if (/server[- ]side\s+apply/.test(lower)) phrases.push("server-side apply");
  if (/managed\s*fields|managedfields/.test(lower)) phrases.push("managedfields");
  if (/force(?:d)?\s+conflicts?|force.*conflict/.test(lower)) phrases.push("force conflicts");
  if (/full[- ]page/.test(lower)) phrases.push("full page");
  if (/hint\s+bits?/.test(lower)) phrases.push("hint bits");
  if (/wal_compression|wal\s+compression/.test(lower)) phrases.push("wal_compression");
  if (/checkpoints?/.test(lower)) phrases.push("checkpoint");
  if (/node(?:\.js)?|nodejs/.test(lower)) phrases.push("node.js");
  if (/process\.nexttick/.test(lower)) phrases.push("process.nexttick");
  if (/queuemicrotask/.test(lower)) phrases.push("queuemicrotask");
  if (/setimmediate/.test(lower)) phrases.push("setimmediate");
  if (/settimeout/.test(lower)) phrases.push("settimeout");
  if (/event\s+loop/.test(lower)) phrases.push("event loop");
  if (/microtasks?/.test(lower)) phrases.push("microtask");
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
      const exact = quotedCoreVariant(q, entityPhrases, anchors);
      variants.push(exact ? `${exact} ${year}` : `${base} ${year}`);
    }
  } else if (intent === "technical_tutorial" || intent === "technical") {
    const primaryEntity = anchors[0] || precisionAnchors[0] || "";
    const distinctive = precisionAnchors.slice(0, 4);
    const phraseTerms = phrases
      .filter((p) => p !== "agent")
      .slice(0, 2)
      .join(" ");
    const suffix = intent === "technical_tutorial"
      ? "official documentation tutorial implementation"
      : "documentation technical implementation";

    const focused = [
      primaryEntity,
      ...distinctive,
      phraseTerms,
      suffix
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    const focusedExact = [
      distinctive[0] ? `"${distinctive[0]}"` : "",
      primaryEntity,
      ...distinctive.slice(1, 4),
      "documentation"
    ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();

    if (brand && precisionAnchors.length >= 2) {
      const brandedPrecise = precisionAnchors
        .filter((p) => p !== brand && !["community", "edition", "documentation", "docs"].includes(p))
        .slice(0, 2)
        .map((p) => `"${p}"`)
        .join(" ");
      variants[0] = `site:${brand}.com/docs ${brandedPrecise} ${phraseTerms} documentation`.replace(/\s+/g, " ").trim();
      variants.push(q);
      variants.push(focused);
    } else {
      variants.push(focused);
      if (focusedExact && focusedExact !== focused) variants.push(focusedExact);
      if (/\bagents?\b/i.test(q) && /\bcrawler|search|retrieval|rag\b/i.test(q)) {
        variants.push(`"web crawler" agents retrieval RAG search open source`);
      }
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
  } else if (intent === "general") {
    const exact = quotedCoreVariant(q, entityPhrases, anchors);
    if (exact && exact.toLowerCase() !== q.toLowerCase()) {
      variants.push(exact);
    } else if (descriptivePhrases.length && anchors.length >= 2) {
      const relational = relationalAnchorVariant(descriptivePhrases, anchors);
      if (relational && relational.toLowerCase() !== q.toLowerCase()) {
        variants.push(relational);
      }

      const relaxed = anchors.slice(0, 6).join(" ");
      if (relaxed && relaxed.toLowerCase() !== q.toLowerCase()) variants.push(relaxed);
    }
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
    queryPhrases,
    entityPhrases,
    descriptivePhrases,
    relationalVariant: relationalAnchorVariant(descriptivePhrases, anchors),
    brand,
    comparisonTarget,
    comparisonMode,
    strictPrecision,
    variants: uniq(variants.filter(Boolean)).slice(0, 3)
  };
}

function escapeRegex(value) {
  const specials = "\\.^$*+?()[]{}|";
  return String(value || "")
    .split("")
    .map((ch) => specials.includes(ch) ? "\\" + ch : ch)
    .join("");
}

function singularQueryForm(term) {
  const value = String(term || "").toLowerCase();
  if (value.length > 5 && value.endsWith("ies")) {
    return value.slice(0, -3) + "y";
  }
  if (
    value.length > 4 &&
    value.endsWith("s") &&
    !value.endsWith("ss")
  ) {
    return value.slice(0, -1);
  }
  return null;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;

  const hay = String(haystack || "").toLowerCase();
  const term = String(needle || "").toLowerCase();

  if (/^[a-z0-9]+$/.test(term)) {
    const countExact = (candidate) => {
      const re = new RegExp(
        "(^|[^a-z0-9])" + escapeRegex(candidate) + "(?=$|[^a-z0-9])",
        "g"
      );
      return [...hay.matchAll(re)].length;
    };

    const exactHits = countExact(term);
    if (exactHits) return exactHits;

    const singular = singularQueryForm(term);
    return singular ? countExact(singular) : 0;
  }

  let n = 0;
  let i = 0;
  while ((i = hay.indexOf(term, i)) >= 0) {
    n += 1;
    i += term.length;
  }
  return n;
}

function phraseOccurs(haystack, phrase) {
  const terms = String(phrase || "")
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (!terms.length) return false;

  const body = terms.map(escapeRegex).join("\\s+");
  const re = new RegExp(
    "(^|[^a-z0-9])" + body + "(?=$|[^a-z0-9])",
    "i"
  );
  return re.test(String(haystack || ""));
}

export function relevanceScore(row, analysis) {
  const hay = `${row.title || ""} ${row.snippet || ""} ${row.url || ""}`.toLowerCase();

  let score = 0;
  let anchorHits = 0;
  const precisionHitSet = new Set();

  for (const anchor of analysis.anchors) {
    const hit = countOccurrences(hay, anchor.toLowerCase());
    if (hit) {
      anchorHits++;
      score += Math.min(3, hit) * 1.6;
    }
  }

  for (const anchor of analysis.precisionAnchors || []) {
    if (hay.includes(anchor.toLowerCase())) {
      precisionHitSet.add(anchor.toLowerCase());
      score += 4;
    }
  }

  for (const anchor of row.queryEvidence || []) {
    const lowerAnchor = String(anchor).toLowerCase();
    if ((analysis.precisionAnchors || []).includes(lowerAnchor)) {
      if (!precisionHitSet.has(lowerAnchor)) score += 2.5;
      precisionHitSet.add(lowerAnchor);
    }
  }

  for (const phrase of analysis.phrases) {
    if (hay.includes(phrase)) score += 5;
  }

  for (const phrase of analysis.queryPhrases || []) {
    if (phraseOccurs(hay, phrase)) score += 7;
  }

  if (
    analysis.planner?.provider === "agent-structured" &&
    analysis.sourcePolicy === "broad_web" &&
    analysis.queryContextPhrase
  ) {
    const phrase = String(analysis.queryContextPhrase).toLowerCase();
    if (hay.includes(phrase)) score += 12;
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

    if (row.provider === "github-repositories" && row.comparisonCandidate) {
      if (row.precisionMatched) score += 8;
      if (row.categoryMatched) score += 10;
      if (row.openSourceVerified) score += 4;
    }
  } else if (
    analysis.intent.startsWith("technical") &&
    row.provider === "github-repositories" &&
    row.technicalCandidate
  ) {
    score += 8;
    if (row.openSourceVerified) score += 3;
  }

  const needed = Math.min(2, analysis.anchors.length);
  if (needed > 0 && anchorHits === 0) score -= 8;
  else if (needed > 1 && anchorHits < needed) score -= 2;

  let structuredPrimaryCandidate = false;
  if (
    analysis.planner?.provider === "agent-structured" &&
    analysis.sourcePolicy === "primary" &&
    Array.isArray(analysis.officialDomains) &&
    analysis.officialDomains.length
  ) {
    try {
      const host = new URL(row.url).hostname.toLowerCase().replace(/^www\./, "");
      structuredPrimaryCandidate = analysis.officialDomains.some((domain) => {
        const d = String(domain || "").toLowerCase().replace(/^www\./, "");
        return host === d || host.endsWith(`.${d}`);
      });
    } catch {}
  }

  const structuredSitemapCandidate =
    structuredPrimaryCandidate &&
    /^official-sitemap(?:-cache)?$/.test(String(row.provider || ""));

  const precisionHits = precisionHitSet.size;
  if ((analysis.precisionAnchors || []).length) {
    // Sitemap candidates are only URL-level hypotheses. The structured-agent
    // path validates required evidence after the page is crawled, so do not
    // reject a primary-source URL merely because its URL/title lacks the
    // exact evidence phrase.
    if (precisionHits === 0 && !structuredPrimaryCandidate) score -= 12;
    else if (
      analysis.strictPrecision &&
      !structuredPrimaryCandidate &&
      precisionHits < Math.min(2, analysis.precisionAnchors.length)
    ) {
      score -= 6;
    }
  }

  if (structuredPrimaryCandidate) score += 5;

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

  const evidenceHits = new Set(
    (row.queryEvidence || [])
      .map((x) => String(x).toLowerCase())
      .filter((x) => (analysis.precisionAnchors || []).includes(x))
  );
  for (const anchor of analysis.precisionAnchors || []) {
    if (hay.includes(anchor.toLowerCase())) evidenceHits.add(anchor.toLowerCase());
  }

  if (
    [
      "official-search-verified",
      "official-technical-verified",
      "bing-html-verified"
    ].includes(row.provider) &&
    evidenceHits.size >= required
  ) {
    return true;
  }

  if (
    row.provider === "github-repositories" &&
    row.technicalCandidate &&
    evidenceHits.size >= required
  ) {
    const wantsOpenSource = (analysis.phrases || []).includes("open source");
    if (wantsOpenSource && !row.openSourceVerified) return false;
    return true;
  }

  if (analysis.intent === "technical_comparison" && analysis.comparisonTarget) {
    const mentionsTarget = hay.includes(analysis.comparisonTarget);
    const alternativeSignal = /alternative|alternatives|replacement|competitor|competitors/.test(hay);
    const comparisonSignal = alternativeSignal || /comparison|versus|\bvs\b/.test(hay);
    const categorySignal = /web search|search api|open source|self-hosted|agent|rag|crawler/.test(hay);

    if (analysis.comparisonMode === "alternatives") {
      if (row.provider === "github-repositories" && row.comparisonCandidate) {
        const wantsOpenSource = (analysis.phrases || []).includes("open source");
        if (!row.verifiedComparison) return false;
        if (wantsOpenSource && !row.openSourceVerified) return false;
        return Boolean(row.categoryMatched);
      }
      return alternativeSignal && categorySignal;
    }

    if (mentionsTarget) return comparisonSignal && categorySignal;
    return comparisonSignal && categorySignal;
  }

  return hits >= required;
}
