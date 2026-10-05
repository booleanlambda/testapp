import dns from "node:dns/promises";
import net from "node:net";
import * as cheerio from "cheerio";
import { embedTexts } from "./embedding.js";
import { savePage } from "./storage.js";

const USER_AGENT = "AAUWebSearchBot/0.2 (+https://web-search-api-m30a.onrender.com)";
const MAX_BODY_BYTES = 2_500_000;
const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "gclid", "fbclid", "mc_cid", "mc_eid"
]);

function isPrivateIp(address) {
  if (net.isIPv4(address)) {
    const p = address.split(".").map(Number);
    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224
    );
  }

  if (net.isIPv6(address)) {
    const s = address.toLowerCase();
    return (
      s === "::" ||
      s === "::1" ||
      s.startsWith("fc") ||
      s.startsWith("fd") ||
      s.startsWith("fe8") ||
      s.startsWith("fe9") ||
      s.startsWith("fea") ||
      s.startsWith("feb")
    );
  }

  return true;
}

export async function validatePublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid_url");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("unsupported_protocol");
  }

  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local")) {
    throw new Error("private_host_blocked");
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error("private_host_blocked");
  } else {
    const addresses = await dns.lookup(host, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((x) => isPrivateIp(x.address))) {
      throw new Error("private_host_blocked");
    }
  }

  return url;
}

async function readLimited(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let out = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("response_too_large");
    }
    out += decoder.decode(value, { stream: true });
  }

  out += decoder.decode();
  return out;
}

export async function fetchSafe(rawUrl, options = {}) {
  let current = (await validatePublicUrl(rawUrl)).toString();
  const timeoutMs = Math.max(500, Math.min(Number(options.timeoutMs || 12000), 12000));
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  for (let redirects = 0; redirects <= 5; redirects++) {
    await validatePublicUrl(current);

    const response = await fetch(current, {
      method: "GET",
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/markdown,text/plain;q=0.8,*/*;q=0.1",
        "accept-language": "en-US,en;q=0.8"
      },
      signal
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("redirect_without_location");
      current = new URL(location, current).toString();
      continue;
    }

    if (!response.ok) throw new Error(`http_${response.status}`);

    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (
      !type.includes("text/html") &&
      !type.includes("application/xhtml+xml") &&
      !type.includes("text/plain") &&
      !type.includes("text/markdown")
    ) {
      throw new Error("unsupported_content_type");
    }

    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BODY_BYTES) throw new Error("response_too_large");

    return {
      url: current,
      statusCode: response.status,
      contentType: type,
      body: await readLimited(response)
    };
  }

  throw new Error("too_many_redirects");
}

function cleanText(value = "") {
  return String(value)
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function normalizeUrl(raw, base = undefined) {
  try {
    const u = base ? new URL(raw, base) : new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return null;
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
    if (u.pathname !== "/" && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    return u.toString();
  } catch {
    return null;
  }
}

function canonicalizeLink(href, base) {
  return normalizeUrl(href, base);
}

function markdownCandidateUrls($, pageUrl, canonicalUrl, bodyText) {
  const candidates = [];

  $('link[rel~="alternate"][type="text/markdown"][href]').each((_, el) => {
    const href = normalizeUrl($(el).attr("href"), pageUrl);
    if (href) candidates.push(href);
  });

  $('a[href$=".md"]').each((_, el) => {
    const href = normalizeUrl($(el).attr("href"), pageUrl);
    if (href) candidates.push(href);
  });

  if (/markdown versions of all pages are available by appending \.md/i.test(bodyText)) {
    try {
      const u = new URL(canonicalUrl || pageUrl);
      u.search = "";
      u.hash = "";
      u.pathname = u.pathname.replace(/\/+$/, "") + ".md";
      candidates.push(u.toString());
    } catch {}
  }

  return [...new Set(candidates)];
}

export function extractPage(html, url, contentType = "text/html") {
  if (contentType.includes("text/plain") || contentType.includes("text/markdown")) {
    const text = cleanText(html);
    const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim() || null;
    return {
      url: normalizeUrl(url) || url,
      sourceUrl: url,
      title: firstHeading,
      description: null,
      text,
      wordCount: text ? text.split(/\s+/).length : 0,
      links: [],
      markdownUrls: [],
      extraction: contentType.includes("text/markdown") ? "markdown" : "plain"
    };
  }

  const $ = cheerio.load(html);
  const title = cleanText($("title").first().text()) || null;
  const description =
    cleanText($('meta[name="description"]').attr("content")) ||
    cleanText($('meta[property="og:description"]').attr("content")) ||
    null;

  const declaredCanonical =
    $('link[rel="canonical"][href]').first().attr("href") ||
    $('meta[property="og:url"]').first().attr("content") ||
    null;
  const canonicalUrl = normalizeUrl(declaredCanonical || url, url) || normalizeUrl(url) || url;

  const links = [];
  $("a[href]").each((_, el) => {
    const link = canonicalizeLink($(el).attr("href"), url);
    if (link) links.push(link);
  });

  const bodyText = cleanText($("body").text());
  const markdownUrls = markdownCandidateUrls($, url, canonicalUrl, bodyText);

  $("script,style,noscript,svg,canvas,form,iframe,template").remove();

  const candidates = [
    "article",
    "main article",
    '[role="main"] article',
    "main",
    '[role="main"]',
    ".markdown-body",
    ".theme-doc-markdown",
    ".documentation-content",
    ".docs-content"
  ];

  let root = null;
  for (const selector of candidates) {
    const node = $(selector).first();
    if (cleanText(node.text()).length >= 300) {
      root = node;
      break;
    }
  }
  if (!root) root = $("body");

  root.find(
    "nav,footer,aside,header,[role=navigation],[aria-label*=breadcrumb i]," +
    "[class*=sidebar i],[class*=toc i],[class*=navigation i],[class*=footer i]," +
    "button,form"
  ).remove();

  const blocks = [];
  root.find("h1,h2,h3,h4,p,li,pre,code,blockquote,td,th,dd,dt").each((_, el) => {
    const t = cleanText($(el).text());
    if (t.length >= 2) blocks.push(t);
  });

  let text = cleanText(blocks.join("\n"));
  if (text.length < 200) text = cleanText(root.text());

  return {
    url: canonicalUrl,
    sourceUrl: normalizeUrl(url) || url,
    title,
    description,
    text,
    wordCount: text ? text.split(/\s+/).length : 0,
    links: [...new Set(links)],
    markdownUrls,
    extraction: "html"
  };
}

function looksLikeThinShell(page) {
  const text = String(page?.text || "");
  if (text.length < 500) return true;
  const navSignals = [
    "docs menu",
    "copy page",
    "rate this page",
    "ask mongodb ai",
    "next",
    "previous"
  ];
  const lowered = text.toLowerCase();
  const signalCount = navSignals.filter((x) => lowered.includes(x)).length;
  return signalCount >= 3 && text.length < 1800;
}

async function enrichWithMarkdown(page, options = {}) {
  if (!page?.markdownUrls?.length) return page;
  if (!looksLikeThinShell(page) && page.text.length >= 1500) return page;

  for (const markdownUrl of page.markdownUrls.slice(0, 3)) {
    try {
      const fetched = await fetchSafe(markdownUrl, options);
      const markdownPage = extractPage(fetched.body, fetched.url, fetched.contentType);
      if (
        markdownPage.text.length >= 500 &&
        markdownPage.text.length > page.text.length * 1.25
      ) {
        return {
          ...page,
          text: markdownPage.text,
          wordCount: markdownPage.wordCount,
          extraction: markdownPage.extraction,
          contentSourceUrl: fetched.url
        };
      }
    } catch {}
  }

  return page;
}

export function chunkText(text, target = 1200, overlap = 180) {
  const source = cleanText(text);
  if (!source) return [];

  const rawParts = source.split(/\n+/).flatMap((part) => {
    if (part.length <= target) return [part];
    const pieces = [];
    for (let i = 0; i < part.length; i += target) {
      pieces.push(part.slice(i, i + target));
    }
    return pieces;
  });

  const chunks = [];
  let current = "";

  for (const part of rawParts) {
    if (!current) {
      current = part;
      continue;
    }

    if (current.length + 1 + part.length <= target) {
      current += "\n" + part;
      continue;
    }

    chunks.push(current.trim());
    const tail = current.slice(Math.max(0, current.length - overlap));
    current = cleanText(tail + "\n" + part);
  }

  if (current) chunks.push(current.trim());
  return chunks.filter((x) => x.length >= 40);
}

function parseRobots(text) {
  const rules = [];
  let applies = false;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("aauwebsearchbot");
    } else if (applies && key === "disallow" && value) {
      rules.push(value);
    }
  }

  return rules;
}

async function robotsRules(origin, cache, options = {}) {
  if (cache.has(origin)) return cache.get(origin);
  try {
    const response = await fetchSafe(new URL("/robots.txt", origin).toString(), options);
    const rules = parseRobots(response.body);
    cache.set(origin, rules);
    return rules;
  } catch {
    cache.set(origin, []);
    return [];
  }
}

async function allowedByRobots(rawUrl, cache, options = {}) {
  const u = new URL(rawUrl);
  const rules = await robotsRules(u.origin, cache, options);
  return !rules.some((rule) => u.pathname.startsWith(rule));
}

function normalizeStart(raw) {
  return normalizeUrl(raw) || raw;
}

export async function fetchPageFast(startUrl, options = {}) {
  const respectRobots = options.respectRobots !== false;
  const timeoutMs = Math.max(1000, Math.min(Number(options.timeoutMs || 5000), 8000));
  const start = normalizeStart((await validatePublicUrl(startUrl)).toString());
  const robotsCache = new Map();

  if (
    respectRobots &&
    !(await allowedByRobots(start, robotsCache, {
      signal: options.signal,
      timeoutMs: Math.min(timeoutMs, 1500)
    }))
  ) {
    throw new Error("robots_disallowed");
  }

  const fetched = await fetchSafe(start, {
    signal: options.signal,
    timeoutMs
  });

  let page = extractPage(fetched.body, fetched.url, fetched.contentType);
  if (options.enrichMarkdown !== false) {
    page = await enrichWithMarkdown(page, {
      signal: options.signal,
      timeoutMs: Math.min(timeoutMs, 3500)
    });
  }

  if (page.text.length < 80) throw new Error("insufficient_text");

  return {
    ...page,
    statusCode: fetched.statusCode,
    contentType: fetched.contentType
  };
}

export async function crawlSite(startUrl, options = {}) {
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || 1), 10));
  const maxDepth = Math.max(0, Math.min(Number(options.depth || 0), 2));
  const sameOrigin = options.sameOrigin !== false;
  const respectRobots = options.respectRobots !== false;

  const start = normalizeStart((await validatePublicUrl(startUrl)).toString());
  const origin = new URL(start).origin;
  const pending = [{ url: start, depth: 0 }];
  const seen = new Set();
  const canonicalSeen = new Set();
  const robotsCache = new Map();
  const pages = [];
  const failures = [];

  while (pending.length && pages.length < maxPages) {
    const item = pending.shift();
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);

    try {
      if (respectRobots && !(await allowedByRobots(item.url, robotsCache))) {
        failures.push({ url: item.url, reason: "robots_disallowed" });
        continue;
      }

      const fetched = await fetchSafe(item.url);
      let page = extractPage(fetched.body, fetched.url, fetched.contentType);
      page = await enrichWithMarkdown(page);

      if (canonicalSeen.has(page.url)) {
        failures.push({ url: item.url, canonicalUrl: page.url, reason: "duplicate_canonical" });
        continue;
      }
      canonicalSeen.add(page.url);

      if (page.text.length < 80) {
        failures.push({ url: item.url, reason: "insufficient_text" });
        continue;
      }

      const chunks = chunkText(page.text);
      const { vectors, model } = await embedTexts(chunks);
      const saved = await savePage(
        {
          ...page,
          statusCode: fetched.statusCode,
          contentType: fetched.contentType
        },
        chunks,
        vectors,
        model
      );

      pages.push({
        url: page.url,
        sourceUrl: page.sourceUrl,
        title: page.title,
        wordCount: page.wordCount,
        chunkCount: saved.chunkCount,
        documentId: saved.documentId,
        embeddingModel: model,
        extraction: page.extraction,
        contentSourceUrl: page.contentSourceUrl || null
      });

      if (item.depth < maxDepth) {
        for (const link of page.links) {
          const u = new URL(link);
          if (sameOrigin && u.origin !== origin) continue;
          if (!seen.has(link)) pending.push({ url: link, depth: item.depth + 1 });
          if (pending.length > 100) break;
        }
      }
    } catch (error) {
      failures.push({
        url: item.url,
        reason: error?.message || "crawl_failed"
      });
    }
  }

  return {
    startUrl: start,
    indexedPages: pages.length,
    pages,
    failures
  };
}
