export const AGENT_SEARCH_PROTOCOL = "agent-search-v1";

function cleanBaseUrl(value) {
  return String(value || "").trim().replace(/\/$/, "");
}

export async function agentSearch({
  baseUrl,
  apiKey,
  request,
  timeoutMs = 15000,
  signal = null,
}) {
  const root = cleanBaseUrl(baseUrl);
  if (!root) throw new Error("crawler_base_url_required");
  if (!request?.query) throw new Error("crawler_query_required");

  const timeout = AbortSignal.timeout(Math.max(1000, Math.min(Number(timeoutMs || 15000), 60000)));
  const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const response = await fetch(`${root}/search`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {}),
    },
    body: JSON.stringify({
      protocol: AGENT_SEARCH_PROTOCOL,
      output: "passages",
      ...request,
    }),
    signal: combinedSignal,
  });

  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { error: "crawler_invalid_json_response", raw: text.slice(0, 500) };
  }

  if (!response.ok) {
    const error = new Error(body?.error || `crawler_http_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}
