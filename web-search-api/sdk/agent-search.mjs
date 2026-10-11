export const AGENT_SEARCH_PROTOCOL = "agent-search-v1";
export const CRAWLER_API_VERSION = "0.9.0";
export const IMAGE_RIGHTS_POLICIES = Object.freeze(["any", "known", "no_attribution", "public_domain"]);

export class CrawlerApiError extends Error {
  constructor(message, { status = null, body = null, endpoint = null } = {}) {
    super(message);
    this.name = "CrawlerApiError";
    this.status = status;
    this.body = body;
    this.endpoint = endpoint;
  }
}

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

function requireBaseUrl(value) {
  const root = cleanBaseUrl(value);
  if (!root) throw new CrawlerApiError("crawler_base_url_required");
  return root;
}

function requireQuery(value) {
  const query = String(value || "").trim();
  if (!query) throw new CrawlerApiError("crawler_query_required");
  return query;
}

function requestSignal(timeoutMs, signal) {
  const timeout = AbortSignal.timeout(
    Math.max(1000, Math.min(Number(timeoutMs || 15000), 60000))
  );
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function parseJsonResponse(response, endpoint) {
  const text = await response.text();
  let body;

  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {
      error: "crawler_invalid_json_response",
      raw: text.slice(0, 500),
    };
  }

  if (!response.ok) {
    throw new CrawlerApiError(
      body?.error || `crawler_http_${response.status}`,
      {
        status: response.status,
        body,
        endpoint,
      }
    );
  }

  return body;
}

async function postJson({
  baseUrl,
  apiKey,
  endpoint,
  body,
  timeoutMs = 15000,
  signal = null,
}) {
  const root = requireBaseUrl(baseUrl);
  const path = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;

  const response = await fetch(`${root}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal(timeoutMs, signal),
  });

  return parseJsonResponse(response, path);
}

export async function agentSearch({
  baseUrl,
  apiKey,
  request,
  timeoutMs = 15000,
  signal = null,
}) {
  const query = requireQuery(request?.query);

  return postJson({
    baseUrl,
    apiKey,
    endpoint: "/search",
    timeoutMs,
    signal,
    body: {
      protocol: AGENT_SEARCH_PROTOCOL,
      output: "passages",
      ...request,
      query,
    },
  });
}

export async function imageSearch({
  baseUrl,
  apiKey,
  query,
  options = {},
  timeoutMs = 15000,
  signal = null,
}) {
  return postJson({
    baseUrl,
    apiKey,
    endpoint: "/images",
    timeoutMs,
    signal,
    body: {
      query: requireQuery(query),
      ...options,
    },
  });
}

export async function videoSearch({
  baseUrl,
  apiKey,
  query,
  options = {},
  timeoutMs = 15000,
  signal = null,
}) {
  return postJson({
    baseUrl,
    apiKey,
    endpoint: "/videos",
    timeoutMs,
    signal,
    body: {
      query: requireQuery(query),
      ...options,
    },
  });
}

export function mediaRights(result = {}) {
  const rights =
    result?.rights && typeof result.rights === "object"
      ? result.rights
      : {};

  return {
    license: rights.license ?? result.license ?? "unknown",
    license_url: rights.license_url ?? result.license_url ?? null,
    copyright_status:
      rights.copyright_status ?? result.copyright_status ?? "unknown",
    copyright_notice:
      rights.copyright_notice ?? result.copyright_notice ?? null,
    creator: rights.creator ?? result.creator ?? null,
    creator_url: rights.creator_url ?? result.creator_url ?? null,
    attribution_required:
      typeof (rights.attribution_required ?? result.attribution_required) === "boolean"
        ? (rights.attribution_required ?? result.attribution_required)
        : null,
    attribution_text:
      rights.attribution_text ?? result.attribution_text ?? null,
    rights_verified: rights.rights_verified === true,
    verification_note:
      rights.verification_note ??
      "Verify the source page before reuse or redistribution.",
  };
}

export function createCrawlerClient({
  baseUrl,
  apiKey = null,
  timeoutMs = 15000,
} = {}) {
  const root = requireBaseUrl(baseUrl);

  return Object.freeze({
    protocol: AGENT_SEARCH_PROTOCOL,
    apiVersion: CRAWLER_API_VERSION,

    search(request, options = {}) {
      return agentSearch({
        baseUrl: root,
        apiKey,
        request,
        timeoutMs: options.timeoutMs ?? timeoutMs,
        signal: options.signal ?? null,
      });
    },

    images(query, options = {}, requestOptions = {}) {
      return imageSearch({
        baseUrl: root,
        apiKey,
        query,
        options,
        timeoutMs: requestOptions.timeoutMs ?? timeoutMs,
        signal: requestOptions.signal ?? null,
      });
    },

    videos(query, options = {}, requestOptions = {}) {
      return videoSearch({
        baseUrl: root,
        apiKey,
        query,
        options,
        timeoutMs: requestOptions.timeoutMs ?? timeoutMs,
        signal: requestOptions.signal ?? null,
      });
    },

    rights(result) {
      return mediaRights(result);
    },
  });
}
