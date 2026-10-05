export function openApiSpec({ serverUrl = "https://web-search-api-m30a.onrender.com" } = {}) {
  return {
    openapi: "3.1.0",
    info: {
      title: "Crawler Agent Search API",
      version: "0.6.0",
      description: "Agent-first web retrieval. The calling agent supplies intent and evidence requirements; Crawler performs deterministic discovery, fetching, ranking, and evidence validation."
    },
    servers: [{ url: serverUrl.replace(/\/$/, "") }],
    components: {
      securitySchemes: {
        ApiKeyAuth: { type: "apiKey", in: "header", name: "x-api-key" },
        BearerAuth: { type: "http", scheme: "bearer" }
      },
      schemas: {
        AgentSearchRequest: {
          type: "object",
          required: ["protocol", "query"],
          properties: {
            protocol: { const: "agent-search-v1" },
            query: { type: "string", minLength: 1 },
            intent: { enum: ["general","news","technical","technical_tutorial","technical_comparison","commercial"] },
            goal: { enum: ["find","explain","verify","compare","research","collect_evidence","monitor"] },
            entities: { type: "array", items: { type: "string" }, maxItems: 8 },
            concepts: { type: "array", items: { type: "string" }, maxItems: 12 },
            source_policy: { enum: ["primary","authoritative","broad_web","community"] },
            preferred_domains: { type: "array", items: { type: "string" }, maxItems: 12 },
            excluded_domains: { type: "array", items: { type: "string" }, maxItems: 12 },
            required_evidence: { type: "array", items: { type: "string" }, maxItems: 12 },
            freshness: { oneOf: [{ enum: ["realtime","24h","7d","any"] }, { type: "integer", minimum: 60, maximum: 86400 }] },
            depth: { enum: ["quick","normal","deep"] },
            max_results: { type: "integer", minimum: 1, maximum: 20 },
            crawl_budget: { type: "integer", minimum: 1, maximum: 10 },
            strict_discovery: { type: "boolean", default: false },
            output: { const: "passages" }
          }
        }
      }
    },
    paths: {
      "/health": {
        get: { summary: "Service health", responses: { "200": { description: "Ready" }, "503": { description: "Missing configuration" } } }
      },
      "/agent-search-schema": {
        get: { summary: "Machine-readable agent request schema", responses: { "200": { description: "Schema" } } }
      },
      "/openapi.json": {
        get: { summary: "OpenAPI specification", responses: { "200": { description: "OpenAPI 3.1 document" } } }
      },
      "/search": {
        post: {
          summary: "Structured agent search",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/AgentSearchRequest" } } }
          },
          responses: {
            "200": { description: "Ranked passages and evidence coverage" },
            "400": { description: "Invalid request" },
            "401": { description: "Missing or invalid API key" }
          }
        }
      },
      "/discover": {
        get: {
          summary: "Discovery-only search",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          parameters: [
            { name: "q", in: "query", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 20 } }
          ],
          responses: { "200": { description: "Discovered URLs" }, "401": { description: "Unauthorized" } }
        }
      },
      "/crawl": {
        post: {
          summary: "Queue or synchronously crawl a URL",
          security: [{ ApiKeyAuth: [] }, { BearerAuth: [] }],
          responses: { "202": { description: "Queued" }, "200": { description: "Synchronous completion" }, "401": { description: "Unauthorized" } }
        }
      }
    }
  };
}
