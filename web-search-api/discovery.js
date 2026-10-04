import * as cheerio from "cheerio";
import { sha256, getDiscoveryCache, setDiscoveryCache } from "./storage.js";
import { analyzeQuery, relevanceScore, passesPrecision } from "./intent.js";

const DISCOVERY_UA = "Mozilla/5.0 (compatible; AAUWebSearch/0.4.2; +https://web-search-api-m30a.onrender.com)";
const DISCOVERY_CACHE_VERSION = 17;
let nextAllowedAt = 0;

async function throttle(ms = 850) {
  const wait = Math.max(0, nextAllowedAt - Date.now());
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  nextAllowedAt = Date.now() + ms;
}

function normalizeResultUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://duckduckgo.com");
    if (u.hostname.endsWith("duckduckgo.com") && u.searchParams.get("uddg")) {
      return decodeURIComponent(u.searchParams.get("uddg"));
    }
    if (u.hostname.endsWith("bing.com") && /\/news\/apiclick\.aspx$/i.test(u.pathname) && u.searchParams.get("url")) {
      return decodeURIComponent(u.searchParams.get("url"));
    }
    if (u.hostname.endsWith("bing.com") && /\/ck\/a$/i.test(u.pathname) && u.searchParams.get("u")) {
      const encoded = u.searchParams.get("u");
      try {
        const payload = encoded.startsWith("a1") ? encoded.slice(2) : encoded;
        const decoded = Buffer.from(payload, "base64url").toString("utf8");
        if (/^https?:\/\//i.test(decoded)) return decoded;
      } catch {}
    }
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function normalizeRows(rows, provider) {
  return rows.map((row, index) => ({
    title: row.title || null,
    url: normalizeResultUrl(row.url),
    snippet: row.snippet || null,
    publishedAt: row.publishedAt || null,
    provider,
    rank: index + 1,
    precisionMatched: Boolean(row.precisionMatched),
    comparisonCandidate: Boolean(row.comparisonCandidate),
    categoryMatched: Boolean(row.categoryMatched),
    verifiedComparison: Boolean(row.verifiedComparison),
    openSourceVerified: Boolean(row.openSourceVerified),
    technicalCandidate: Boolean(row.technicalCandidate),
    queryEvidence: Array.isArray(row.queryEvidence) ? row.queryEvidence : []
  })).filter((row) => row.url);
}

function canonicalResultKey(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    u.search = "";
    const path = u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "/";
    return `${u.origin}${path}`;
  } catch {
    return rawUrl;
  }
}

function fuse(rows, analysis, limit) {
  const byUrl = new Map();

  for (const row of rows) {
    const key = canonicalResultKey(row.url);
    const current = byUrl.get(key);
    const scored = {
      ...row,
      relevance: relevanceScore(row, analysis)
    };

    if (!current || scored.relevance > current.relevance) {
      byUrl.set(key, scored);
    }
  }

  let ranked = [...byUrl.values()]
    .sort((a, b) => {
      if (b.relevance !== a.relevance) return b.relevance - a.relevance;
      return (a.rank || 99) - (b.rank || 99);
    });

  if (analysis.strictPrecision) {
    ranked = ranked.filter((row) => passesPrecision(row, analysis));
  }

  if (analysis.intent.startsWith("technical")) {
    ranked = ranked.filter((row) => row.relevance >= 0);
  }

  if (analysis.intent === "news") {
    const focused = ranked.filter((row) => row.relevance >= 0);
    if (focused.length) ranked = focused;
  }

  ranked = ranked
    .slice(0, limit)
    .map((row, index) => ({
      title: row.title,
      url: row.url,
      snippet: row.snippet,
      publishedAt: row.publishedAt,
      provider: row.provider,
      rank: index + 1,
      relevance: Number(row.relevance.toFixed(3)),
      verifiedComparison: row.verifiedComparison || undefined,
      openSourceVerified: row.openSourceVerified || undefined,
      categoryMatched: row.categoryMatched || undefined
    }));

  return ranked;
}

async function discoverSearx(query, limit, category = "general") {
  const base = process.env.SEARCH_DISCOVERY_BASE_URL?.trim();
  if (!base) return [];

  const url = new URL("/search", base);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("categories", category);
  url.searchParams.set("language", "en");

  const response = await fetch(url, {
    headers: { "user-agent": DISCOVERY_UA, accept: "application/json" },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`searx_${response.status}`);

  const json = await response.json();
  return normalizeRows(
    (json?.results || []).slice(0, limit).map((x) => ({
      title: x.title,
      url: x.url,
      snippet: x.content,
      publishedAt: x.publishedDate || x.published_date || null
    })),
    category === "news" ? "searxng-news" : "searxng"
  );
}

async function discoverBingNews(query, limit) {
  await throttle();
  const url = new URL("https://www.bing.com/news/search");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "rss");
  url.searchParams.set("count", "20");

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.1"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`bing_news_${response.status}`);

  const xml = await response.text();
  const $ = cheerio.load(xml, { xmlMode: true });
  const rows = [];
  $("item").each((_, item) => {
    rows.push({
      title: $(item).find("title").first().text().trim(),
      url: $(item).find("link").first().text().trim(),
      snippet: $(item).find("description").first().text().trim(),
      publishedAt: $(item).find("pubDate").first().text().trim() || null
    });
  });

  return normalizeRows(rows.slice(0, Math.max(limit, 20)), "bing-news-rss");
}

async function discoverBingHtml(query, limit) {
  await throttle();
  const url = new URL("https://www.bing.com/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "20");

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(6500)
  });
  if (!response.ok) throw new Error(`bing_html_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];
  $("li.b_algo").each((_, item) => {
    const link = $(item).find("h2 a").first();
    rows.push({
      title: link.text().trim(),
      url: link.attr("href"),
      snippet: $(item).find(".b_caption p").first().text().trim() || $(item).find("p").first().text().trim()
    });
  });

  return normalizeRows(rows.slice(0, Math.max(limit, 20)), "bing-html");
}

function githubCategorySignal(item) {
  const descriptive = [
    item?.full_name,
    item?.name,
    item?.description
  ].filter(Boolean).join(" ").toLowerCase();
  const topics = (Array.isArray(item?.topics) ? item.topics : []).join(" ").toLowerCase();

  const directSearch =
    /\bmetasearch(?:[- ]engine)?\b|\bsearch[- ]engine\b|\bweb[- ]search\b|\bsearch[- ]api\b|\bai[- ]search\b|\bcrawler\b|\bscraper\b/.test(descriptive);
  const strongTopic =
    /metasearch-engine|search-engine|web-search|ai-search|ai-crawler|web-crawler|\bcrawler\b/.test(topics);
  const functionalDescription =
    /search|engine|crawl|scrap|retrieval|api/.test(descriptive);

  return directSearch || (strongTopic && functionalDescription);
}

function githubTechnicalCategorySignal(item, analysis) {
  const name = `${item?.full_name || ""} ${item?.name || ""}`.toLowerCase();
  const description = String(item?.description || "").toLowerCase();
  const topics = (Array.isArray(item?.topics) ? item.topics : []).join(" ").toLowerCase();

  if ((analysis.phrases || []).includes("web crawler")) {
    const nameSignal = /crawl|scrap|browser/.test(name);
    const descriptionSignal =
      /\bweb crawler\b|\bcrawler\b|\bscraper\b|\bweb scraping\b|\bdata extraction\b|\bhtml[- ]to[- ]markdown\b/.test(description);
    const topicSignal =
      /\bweb-crawler\b|\bcrawler\b|\bweb-scraping\b|\bscraper\b|\bdata-extraction\b/.test(topics);
    return nameSignal || descriptionSignal || topicSignal;
  }

  const hay = `${name} ${description} ${topics}`;
  return /developer|sdk|api|database|vector|embedding|search|retrieval|crawler|scraper/.test(hay);
}

async function fetchGitHubRepositoryEvidence(row) {
  let repoPath = "";
  try {
    repoPath = new URL(row.url).pathname.replace(/^\/+|\/+$/g, "");
  } catch {
    return "";
  }
  if (!/^[^/]+\/[^/]+$/.test(repoPath)) return "";

  const headers = {
    "user-agent": DISCOVERY_UA,
    accept: "application/vnd.github.raw+json",
    "x-github-api-version": "2022-11-28"
  };
  if (process.env.GITHUB_DISCOVERY_TOKEN) {
    headers.authorization = `Bearer ${process.env.GITHUB_DISCOVERY_TOKEN}`;
  }

  try {
    const response = await fetch(`https://api.github.com/repos/${repoPath}/readme`, {
      headers,
      signal: AbortSignal.timeout(6000)
    });
    if (response.ok) {
      const text = await response.text();
      if (text.trim()) return text;
    }
  } catch {}

  try {
    const html = await fetchText(row.url, 6000);
    const $ = cheerio.load(html);
    return (
      $("#readme").text() ||
      $("article.markdown-body").text() ||
      $("body").text() ||
      ""
    ).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

function comparisonCategoryEvidence(text, categoryPhrase) {
  const hay = String(text || "").toLowerCase();

  if (categoryPhrase === "web search api" || categoryPhrase === "search api") {
    return /\bweb search\b|\bsearch api\b|\bsearch engine\b|\bmetasearch\b|\bsearch endpoint\b|\binternet search\b|\bsearch the web\b/.test(hay);
  }

  if (categoryPhrase === "web crawler") {
    return /\bweb crawler\b|\bcrawler\b|\bweb scraping\b|\bscraper\b|\bdata extraction\b/.test(hay);
  }

  if (categoryPhrase === "vector search") {
    return /\bvector search\b|\bsemantic search\b|\bvector database\b|\bembedding search\b/.test(hay);
  }

  return /\bsearch\b|\bretrieval\b|\bapi\b|\bcrawler\b|\bagent\b|\brag\b/.test(hay);
}

async function verifyGitHubComparisonRows(rows, analysis, categoryPhrase, limit) {
  const wantsOpenSource = (analysis.phrases || []).includes("open source");
  const candidates = rows.slice(0, Math.min(Math.max(limit, 6), 10));

  const checked = await Promise.all(candidates.map(async (row) => {
    const evidence = await fetchGitHubRepositoryEvidence(row);
    if (!evidence) return null;

    const combined = `${row.title || ""} ${row.snippet || ""} ${evidence}`;
    const categoryMatched = comparisonCategoryEvidence(combined, categoryPhrase);
    if (!categoryMatched) return null;
    if (wantsOpenSource && !row.openSourceVerified) return null;

    const target = analysis.comparisonTarget?.toLowerCase();
    const targetMentioned = target && combined.toLowerCase().includes(target);

    return {
      ...row,
      categoryMatched: true,
      verifiedComparison: true,
      queryEvidence: targetMentioned ? [target] : row.queryEvidence || []
    };
  }));

  return checked.filter(Boolean);
}

async function discoverGitHubRepositories(analysis, limit) {
  const target = analysis.comparisonTarget || analysis.brand;
  if (!target) return [];

  const wantsOpenSource = (analysis.phrases || []).includes("open source");
  const categoryPhrase =
    (analysis.phrases || []).find((p) =>
      ["web search api", "search api", "web crawler", "vector search"].includes(p)
    ) || "web search api";

  const queries = [
    {
      q: `${target} alternative in:name,description,readme`,
      precisionMatched: true,
      comparisonCandidate: true,
      categoryMatched: false
    },
    {
      q: `${target} replacement in:name,description,readme`,
      precisionMatched: true,
      comparisonCandidate: true,
      categoryMatched: false
    }
  ];

  if (categoryPhrase === "web search api" || categoryPhrase === "search api") {
    queries.push(
      {
        q: "topic:metasearch stars:>25",
        precisionMatched: false,
        comparisonCandidate: true,
        categoryMatched: true
      },
      {
        q: "topic:web-search stars:>50",
        precisionMatched: false,
        comparisonCandidate: true,
        categoryMatched: true
      }
    );
  } else {
    queries.push({
      q: `${categoryPhrase.replace(/"/g, "")} in:name,description,readme stars:>10`,
      precisionMatched: false,
      comparisonCandidate: true,
      categoryMatched: true
    });
  }

  const rows = [];
  const seen = new Set();

  for (const spec of queries) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", spec.q);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(Math.min(10, Math.max(limit, 6))));

    const headers = {
      "user-agent": DISCOVERY_UA,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };
    if (process.env.GITHUB_DISCOVERY_TOKEN) {
      headers.authorization = `Bearer ${process.env.GITHUB_DISCOVERY_TOKEN}`;
    }

    let response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      continue;
    }

    if (!response.ok) continue;

    const json = await response.json();
    for (const item of json?.items || []) {
      if (!item?.html_url || seen.has(item.html_url) || item.archived) continue;
      if (/^awesome[-_]/i.test(item.name || "")) continue;

      const license = item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION"
        ? item.license.spdx_id
        : null;
      if (wantsOpenSource && !license) continue;

      const strongCategory = githubCategorySignal(item);
      if (!strongCategory) continue;

      seen.add(item.html_url);
      const topics = Array.isArray(item.topics) ? item.topics.slice(0, 8) : [];
      rows.push({
        title: item.full_name || item.name,
        url: item.html_url,
        snippet: [
          item.description,
          topics.length ? `Topics: ${topics.join(", ")}` : null,
          license ? `License: ${license}` : null,
          item.stargazers_count != null ? `GitHub stars: ${item.stargazers_count}` : null
        ].filter(Boolean).join(" — "),
        publishedAt: item.updated_at || null,
        precisionMatched: spec.precisionMatched,
        comparisonCandidate: spec.comparisonCandidate,
        categoryMatched: spec.categoryMatched || strongCategory,
        openSourceVerified: Boolean(license),
        repoFullName: item.full_name || null,
        defaultBranch: item.default_branch || null
      });
    }

    if (rows.length >= Math.max(limit, 10)) break;
  }

  const verified = await verifyGitHubComparisonRows(rows, analysis, categoryPhrase, limit);
  return normalizeRows(verified.slice(0, Math.max(limit, 10)), "github-repositories");
}

async function discoverGitHubTechnical(analysis, limit) {
  const wantsOpenSource = (analysis.phrases || []).includes("open source");
  const anchors = (analysis.precisionAnchors || []).filter((x) => x !== "github");
  if (anchors.length < 2) return [];

  const distinctive = anchors.filter((x) => !["self-hosted", "selfhosted"].includes(x));
  const specs = [];

  if (distinctive.length >= 2) {
    const evidence = distinctive.slice(0, 3);
    specs.push({
      q: `${evidence.join(" ")} in:name,description,readme`,
      evidence
    });
  }

  const broadEvidence = anchors.slice(0, 3);
  specs.push({
    q: `${broadEvidence.join(" ")} in:name,description,readme`,
    evidence: broadEvidence
  });

  const rows = [];
  const seen = new Set();

  for (const spec of specs) {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", spec.q);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(Math.min(10, Math.max(limit, 6))));

    const headers = {
      "user-agent": DISCOVERY_UA,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28"
    };
    if (process.env.GITHUB_DISCOVERY_TOKEN) {
      headers.authorization = `Bearer ${process.env.GITHUB_DISCOVERY_TOKEN}`;
    }

    let response;
    try {
      response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(10000)
      });
    } catch {
      continue;
    }
    if (!response.ok) continue;

    const json = await response.json();
    for (const item of json?.items || []) {
      if (!item?.html_url || seen.has(item.html_url) || item.archived) continue;
      if (/^awesome[-_]/i.test(item.name || "")) continue;
      if (!githubTechnicalCategorySignal(item, analysis)) continue;

      const license = item.license?.spdx_id && item.license.spdx_id !== "NOASSERTION"
        ? item.license.spdx_id
        : null;
      if (wantsOpenSource && !license) continue;

      seen.add(item.html_url);
      const topics = Array.isArray(item.topics) ? item.topics.slice(0, 8) : [];
      rows.push({
        title: item.full_name || item.name,
        url: item.html_url,
        snippet: [
          item.description,
          topics.length ? `Topics: ${topics.join(", ")}` : null,
          license ? `License: ${license}` : null,
          item.stargazers_count != null ? `GitHub stars: ${item.stargazers_count}` : null
        ].filter(Boolean).join(" — "),
        publishedAt: item.updated_at || null,
        technicalCandidate: true,
        queryEvidence: spec.evidence,
        openSourceVerified: Boolean(license)
      });
    }

    if (rows.length >= Math.max(limit, 8)) break;
  }

  return normalizeRows(rows.slice(0, Math.max(limit, 10)), "github-repositories");
}

async function verifyOfficialSearchRows(rows, analysis, limit) {
  if (!analysis.brand || !analysis.strictPrecision) return rows;

  const brand = analysis.brand.toLowerCase();
  const required = Math.min(2, (analysis.precisionAnchors || []).length);
  if (!required) return rows;

  const candidates = rows.filter((row) => {
    try {
      const host = new URL(row.url).hostname.toLowerCase();
      return host === `${brand}.com` || host.endsWith(`.${brand}.com`);
    } catch {
      return false;
    }
  }).slice(0, Math.min(Math.max(limit, 5), 8));

  const checked = await Promise.all(candidates.map(async (row) => {
    try {
      const html = await fetchText(row.url, 3500);
      const $ = cheerio.load(html);
      const title =
        $("title").first().text().replace(/\s+/g, " ").trim() ||
        row.title ||
        null;
      const meta =
        $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "";
      const body = $("main").text() || $("article").text() || $("body").text() || "";
      const text = `${title || ""} ${meta} ${body}`.replace(/\s+/g, " ").trim();
      const lower = text.toLowerCase();
      const hits = (analysis.precisionAnchors || []).filter((a) =>
        lower.includes(a.toLowerCase())
      );
      if (hits.length < required) return null;

      let focusAt = -1;
      for (const anchor of hits) {
        const i = lower.indexOf(anchor.toLowerCase());
        if (i >= 0 && (focusAt < 0 || i < focusAt)) focusAt = i;
      }
      const start = focusAt >= 0 ? Math.max(0, focusAt - 220) : 0;

      return {
        ...row,
        title,
        snippet: text.slice(start, start + 1100).trim(),
        provider: "official-search-verified",
        queryEvidence: hits
      };
    } catch {
      return null;
    }
  }));

  return checked.filter(Boolean);
}

async function discoverDuckDuckGoHtml(query, limit) {
  await throttle();
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`ddg_html_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const rows = [];
  $(".result").each((_, result) => {
    const link = $(result).find(".result__a").first();
    rows.push({
      title: link.text().trim(),
      url: link.attr("href"),
      snippet: $(result).find(".result__snippet").first().text().trim()
    });
  });

  return normalizeRows(rows.slice(0, limit), "duckduckgo-html");
}

async function discoverDuckDuckGoLite(query, limit) {
  await throttle();
  const url = new URL("https://lite.duckduckgo.com/lite/");
  url.searchParams.set("q", query);

  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "text/html,application/xhtml+xml"
    },
    signal: AbortSignal.timeout(6500)
  });
  if (!response.ok) throw new Error(`ddg_lite_${response.status}`);

  const html = await response.text();
  const $ = cheerio.load(html);
  const links = $("a.result-link").toArray();
  const snippets = $("td.result-snippet").toArray();
  const rows = links.map((link, index) => ({
    title: $(link).text().trim(),
    url: $(link).attr("href"),
    snippet: snippets[index] ? $(snippets[index]).text().replace(/\s+/g, " ").trim() : null
  }));

  return normalizeRows(rows.slice(0, limit), "duckduckgo-lite");
}

async function discoverDuckDuckGo(query, limit) {
  try {
    const html = await discoverDuckDuckGoHtml(query, limit);
    if (html.length) return html;
  } catch {}

  return discoverDuckDuckGoLite(query, limit);
}

function scoreOfficialUrl(url, analysis, parentScore = 0) {
  const lower = String(url).toLowerCase();
  let score = parentScore;

  for (const anchor of analysis.precisionAnchors || []) {
    if (lower.includes(anchor.toLowerCase())) score += 5;
  }

  for (const phrase of analysis.phrases || []) {
    for (const token of phrase.toLowerCase().split(/\s+/)) {
      if (token.length >= 4 && lower.includes(token)) score += 2;
    }
  }

  if (/\/docs\//.test(lower)) score += 3;
  if (/search|vector|api|sdk|reference|guide|tutorial|install|deployment|self-managed/.test(lower)) score += 2;
  if (
    (analysis.anchors || []).some((x) => ["community","self-hosted","selfhosted","local","on-prem","onprem"].includes(x)) &&
    /self-managed|self-hosted|on-prem|local/.test(lower)
  ) score += 8;
  if (/sitemap-index|sitemap-full/.test(lower)) score += 4;
  if (/\/(pt-br|es|ko-kr|ja-jp|it-it|de-de|fr-fr|zh-cn|zh-tw|th-th)\//.test(lower)) score -= 10;

  return score;
}

function xmlLocs(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const sitemapLocs = $("sitemap > loc").map((_, el) => $(el).text().trim()).get();
  if (sitemapLocs.length) return { type: "index", locs: sitemapLocs };

  const pageLocs = $("url > loc").map((_, el) => $(el).text().trim()).get();
  return { type: "urlset", locs: pageLocs };
}

async function fetchText(url, ms = 12000) {
  const response = await fetch(url, {
    headers: {
      "user-agent": DISCOVERY_UA,
      accept: "application/xml,text/xml,text/plain,text/html;q=0.5"
    },
    signal: AbortSignal.timeout(ms)
  });
  if (!response.ok) throw new Error(`official_fetch_${response.status}`);
  return response.text();
}

async function discoverOfficialSitemap(analysis, limit) {
  if (!analysis.brand) return [];

  const hosts = [
    `https://www.${analysis.brand}.com`,
    `https://${analysis.brand}.com`
  ];

  let root = null;
  let robots = "";

  for (const host of hosts) {
    try {
      robots = await fetchText(`${host}/robots.txt`, 8000);
      root = host;
      break;
    } catch {}
  }

  if (!root) return [];

  let sitemapUrls = [...robots.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map((m) => m[1]);
  if (!sitemapUrls.length) {
    sitemapUrls = [`${root}/sitemap.xml`, `${root}/sitemap-index.xml`];
  }

  const queue = sitemapUrls.map((url) => ({
    url,
    depth: 0,
    score: scoreOfficialUrl(url, analysis)
  }));
  const seen = new Set();
  const pages = [];
  const deadline = Date.now() + 9000;

  while (queue.length && seen.size < 8 && pages.length < 50 && Date.now() < deadline) {
    queue.sort((a, b) => b.score - a.score);
    const item = queue.shift();
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);

    let xml;
    try {
      const remaining = Math.max(1000, deadline - Date.now());
      xml = await fetchText(item.url, Math.min(4000, remaining));
    } catch {
      continue;
    }

    const parsed = xmlLocs(xml);
    if (parsed.type === "index" && item.depth < 2) {
      const ranked = parsed.locs
        .map((url) => ({
          url,
          depth: item.depth + 1,
          score: scoreOfficialUrl(url, analysis, item.score * 0.25)
        }))
        .sort((a, b) => b.score - a.score);

      const unlockers = ranked.filter((x) => /\/docs\/.*sitemap-index|\/docs\/sitemap-index/i.test(x.url)).slice(0, 1);
      const focused = ranked.slice(0, 5);
      for (const child of [...unlockers, ...focused]) {
        if (!seen.has(child.url)) queue.push(child);
      }
      continue;
    }

    if (parsed.type === "urlset") {
      for (const url of parsed.locs) {
        const score = scoreOfficialUrl(url, analysis, item.score * 0.15);
        if (score > 2) pages.push({ url, score });
      }
    }
  }

  const candidates = pages
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(Math.max(limit, 5), 6));

  const enriched = await Promise.all(candidates.map(async (row, index) => {
    try {
      const html = await fetchText(row.url, 4000);
      const $ = cheerio.load(html);
      const title =
        $("title").first().text().replace(/\s+/g, " ").trim() ||
        $("h1").first().text().replace(/\s+/g, " ").trim() ||
        null;
      const meta =
        $('meta[name="description"]').attr("content") ||
        $('meta[property="og:description"]').attr("content") ||
        "";
      const body = $("main").text() || $("article").text() || $("body").text() || "";
      const text = `${meta} ${body}`.replace(/\s+/g, " ").trim();

      let focusAt = -1;
      for (const anchor of analysis.precisionAnchors || []) {
        const i = text.toLowerCase().indexOf(anchor.toLowerCase());
        if (i >= 0 && (focusAt < 0 || i < focusAt)) focusAt = i;
      }

      const start = focusAt >= 0 ? Math.max(0, focusAt - 220) : 0;
      const snippet = text.slice(start, start + 1000).trim();

      return {
        title,
        url: row.url,
        snippet: snippet || `Official ${analysis.brand} documentation candidate`,
        publishedAt: null,
        provider: "official-sitemap",
        rank: index + 1
      };
    } catch {
      return {
        title: null,
        url: row.url,
        snippet: `Official ${analysis.brand} documentation candidate`,
        publishedAt: null,
        provider: "official-sitemap",
        rank: index + 1
      };
    }
  }));

  return enriched;
}

async function runVariant(query, analysis, limit) {
  const attempts = [];
  const rows = [];

  if (analysis.intent === "technical_comparison") {
    try {
      const found = await discoverBingHtml(query, limit);
      rows.push(...found);
      attempts.push({ provider: "bing-html", query, ok: found.length > 0 });
      const focused = fuse(rows, analysis, limit);
      if (focused.length >= Math.min(3, limit)) {
        return { rows, attempts };
      }
    } catch (error) {
      attempts.push({ provider: "bing-html", query, ok: false, error: error?.message });
    }

    try {
      const found = await discoverGitHubRepositories(analysis, limit);
      rows.push(...found);
      attempts.push({ provider: "github-repositories", query: analysis.comparisonTarget || query, ok: found.length > 0 });
      const focused = fuse(rows, analysis, limit);
      if (focused.length >= Math.min(3, limit)) {
        return { rows, attempts };
      }
    } catch (error) {
      attempts.push({ provider: "github-repositories", query: analysis.comparisonTarget || query, ok: false, error: error?.message });
    }

    try {
      const found = await discoverDuckDuckGoLite(query, limit);
      rows.push(...found);
      attempts.push({ provider: "duckduckgo-lite", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "duckduckgo-lite", query, ok: false, error: error?.message });
    }

    return { rows, attempts };
  }

  if (process.env.SEARCH_DISCOVERY_BASE_URL) {
    try {
      const category = analysis.intent === "news" ? "news" : "general";
      const found = await discoverSearx(query, limit, category);
      rows.push(...found);
      attempts.push({ provider: category === "news" ? "searxng-news" : "searxng", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "searxng", query, ok: false, error: error?.message });
    }
  }

  if (analysis.intent === "news") {
    try {
      const found = await discoverBingNews(query, limit);
      rows.push(...found);
      attempts.push({ provider: "bing-news-rss", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "bing-news-rss", query, ok: false, error: error?.message });
    }
  } else {
    if (analysis.strictPrecision && analysis.brand && analysis.intent.startsWith("technical")) {
      const [bingResult, ddgResult] = await Promise.allSettled([
        discoverBingHtml(query, limit),
        discoverDuckDuckGoLite(query, limit)
      ]);

      const found = [];
      if (bingResult.status === "fulfilled") {
        found.push(...bingResult.value);
        attempts.push({ provider: "bing-html", query, ok: bingResult.value.length > 0 });
      } else {
        attempts.push({ provider: "bing-html", query, ok: false, error: bingResult.reason?.message });
      }

      if (ddgResult.status === "fulfilled") {
        found.push(...ddgResult.value);
        attempts.push({ provider: "duckduckgo-lite", query, ok: ddgResult.value.length > 0 });
      } else {
        attempts.push({ provider: "duckduckgo-lite", query, ok: false, error: ddgResult.reason?.message });
      }

      const usable = await verifyOfficialSearchRows(found, analysis, limit);
      rows.push(...usable);
      attempts.push({
        provider: "official-search-verified",
        query,
        ok: usable.length > 0
      });
    } else {
      try {
        const found = await discoverBingHtml(query, limit);
        rows.push(...found);
        attempts.push({ provider: "bing-html", query, ok: found.length > 0 });
      } catch (error) {
        attempts.push({ provider: "bing-html", query, ok: false, error: error?.message });
      }
    }

    if (analysis.intent.startsWith("technical")) {
      const focused = fuse(rows, analysis, limit);
      if (focused.length && focused[0].relevance >= 12) {
        return { rows, attempts };
      }
    }

    if (
      (analysis.intent === "technical" || analysis.intent === "technical_tutorial") &&
      ((analysis.phrases || []).includes("web crawler") || (analysis.anchors || []).includes("github"))
    ) {
      try {
        const found = await discoverGitHubTechnical(analysis, limit);
        rows.push(...found);
        attempts.push({ provider: "github-repositories", query: "technical-evidence", ok: found.length > 0 });
        const focused = fuse(rows, analysis, limit);
        if (focused.length && focused[0].relevance >= 12) {
          return { rows, attempts };
        }
      } catch (error) {
        attempts.push({ provider: "github-repositories", query: "technical-evidence", ok: false, error: error?.message });
      }
    }
  }

  if (
    (!rows.length || analysis.intent.startsWith("technical")) &&
    !(analysis.strictPrecision && analysis.brand)
  ) {
    try {
      const found = await discoverDuckDuckGo(query, limit);
      rows.push(...found);
      attempts.push({ provider: found[0]?.provider || "duckduckgo", query, ok: found.length > 0 });
    } catch (error) {
      attempts.push({ provider: "duckduckgo", query, ok: false, error: error?.message });
    }
  }

  return { rows, attempts };
}

export async function discoverWeb(query, options = {}) {
  const q = String(query || "").trim();
  if (!q) throw new Error("query_required");

  const limit = Math.max(1, Math.min(Number(options.limit || 8), 20));
  const cacheTtl = Math.max(30, Math.min(Number(options.cacheTtl || 600), 3600));
  const analysis = analyzeQuery(q);

  const cacheKey = sha256(JSON.stringify({
    cacheVersion: DISCOVERY_CACHE_VERSION,
    q: q.toLowerCase(),
    limit,
    intent: analysis.intent,
    variants: analysis.variants,
    provider: process.env.SEARCH_DISCOVERY_BASE_URL ? "searxng+bing+ddg" : "bing+ddg"
  }));

  const cached = await getDiscoveryCache(cacheKey).catch(() => null);
  if (cached) {
    return { ...cached, cached: true };
  }

  const attempts = [];
  const collected = [];

  for (const variant of analysis.variants) {
    const result = await runVariant(variant, analysis, Math.max(limit, 10));
    attempts.push(...result.attempts);
    collected.push(...result.rows);

    const early = fuse(collected, analysis, limit);
    const strongStrict =
      analysis.strictPrecision &&
      early.length > 0 &&
      early[0]?.relevance >= 12;

    if (strongStrict || (early.length >= limit && early[0]?.relevance >= 4 && variant !== q)) break;
  }

  let results = fuse(collected, analysis, limit);

  if (
    results.length < Math.min(limit, 3) &&
    analysis.strictPrecision &&
    analysis.brand &&
    (analysis.intent === "technical_tutorial" || analysis.intent === "technical")
  ) {
    try {
      const official = await discoverOfficialSitemap(analysis, Math.max(limit, 10));
      attempts.push({ provider: "official-sitemap", query: analysis.brand, ok: official.length > 0 });
      if (official.length) {
        collected.push(...official);
        results = fuse(collected, analysis, limit);
      }
    } catch (error) {
      attempts.push({ provider: "official-sitemap", query: analysis.brand, ok: false, error: error?.message });
    }
  }

  const value = {
    query: q,
    intent: analysis.intent,
    anchors: analysis.anchors,
    precisionAnchors: analysis.precisionAnchors,
    strictPrecision: analysis.strictPrecision,
    effectiveQueries: analysis.variants,
    results,
    provider: results[0]?.provider || null,
    attempts,
    cached: false,
    discoveredAt: new Date().toISOString()
  };

  await setDiscoveryCache(cacheKey, value, cacheTtl).catch(() => {});
  return value;
}
