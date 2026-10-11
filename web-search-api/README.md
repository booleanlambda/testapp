# Crawler — Agent Retrieval API

Crawler is a low-latency retrieval service for autonomous agents.

It gives an agent one retrieval surface for:

- web search + page evidence
- image discovery
- video discovery
- provenance
- copyright / license / attribution metadata when available

The calling agent keeps interpretation authority. Crawler retrieves and validates evidence; it does not decide the agent's final opinion, post, answer, or action.

Current API version: **0.8.0**

## Retrieval model

```
agent reasoning
  -> structured retrieval request
  -> cache / indexed corpus
  -> free discovery providers on miss
  -> direct source retrieval when needed
  -> ranking + evidence/provenance
  -> agent
```

For structured web requests, the agent can send semantics it already knows instead of paying for another LLM planner in the search path.

Media retrieval is also deterministic: Crawler discovers existing images/videos and returns the source and rights metadata it can observe. It does not generate media.

## Endpoints

| Purpose | Endpoint |
|---|---|
| Health | `GET /health` |
| Diagnostics | `GET /diagnostics` |
| Structured web search | `POST /search` |
| Discovery-only web search | `GET /discover?q=...` |
| Image search | `GET /images?q=...` or `POST /images` |
| Video search | `GET /videos?q=...` or `POST /videos` |
| Crawl | `POST /crawl` |
| Crawl status | `GET /crawl/:jobId` |
| Agent schema | `GET /agent-search-schema` |
| OpenAPI | `GET /openapi.json` |

Current service limits include 20 web-search results, 30 image results, 30 video results, crawl depth up to 2, and up to 10 pages per crawl request.

## Authentication

When `SEARCH_API_KEY` or `SEARCH_API_KEYS` is configured, protected endpoints accept either:

```
x-api-key: <key>
```

or:

```
Authorization: Bearer <key>
```

Public endpoints:

- `/`
- `/health`
- `/agent-search-schema`
- `/openapi.json`

Do not commit API keys or infrastructure secrets.

## SDK

A dependency-free Node SDK is included at:

```
sdk/agent-search.mjs
```

It supports both the convenience client and the original direct functions.

### Recommended client

```js
import { createCrawlerClient } from "./sdk/agent-search.mjs";

const crawler = createCrawlerClient({
  baseUrl: process.env.CRAWLER_URL,
  apiKey: process.env.CRAWLER_API_KEY,
});
```

### Web search

```js
const result = await crawler.search({
  query: "What happens when one asyncio TaskGroup task fails?",
  intent: "technical",
  goal: "explain",
  entities: ["Python", "asyncio"],
  concepts: ["TaskGroup", "task cancellation", "ExceptionGroup"],
  source_policy: "primary",
  preferred_domains: ["docs.python.org"],
  required_evidence: ["TaskGroup", "cancel", "ExceptionGroup"],
  depth: "deep",
  max_results: 6,
  crawl_budget: 4,
});
```

Crawler automatically sends:

```
protocol = agent-search-v1
output   = passages
```

For structured requests, planner metadata should show `provider=agent-structured` and no planner model.

A web response can include:

- ranked `results`
- source URLs
- `discovery` provenance and provider diagnostics
- `evidence.required`
- `evidence.matched`
- `evidence.missing`
- `evidence.complete`
- `fastPath` information
- crawl activity

An agent can use `evidence.complete` as a deterministic stop/continue signal.

## Image search

```js
const images = await crawler.images("Accra skyline at night", {
  max_results: 12,
  safe_search: "moderate",
  aspect: "wide",
  rights: "known",
  min_width: 900,
  min_height: 500,
});
```

The free image path currently uses:

```
Wikimedia Commons
        |
        v
SearxNG images, when configured
        |
        v
DuckDuckGo Images
        |
        v
Bing Images fallback
```

Wikimedia Commons is preferred because it exposes structured creator, license, attribution, copyright, permission, and restriction metadata alongside the media itself.

Typical image result fields:

```json
{
  "title": "Example image",
  "image_url": "https://...",
  "thumbnail_url": "https://...",
  "source_url": "https://...",
  "width": 1600,
  "height": 900,
  "provider": "bing-images-html",
  "license": "unknown",
  "license_url": null,
  "copyright_status": "unknown",
  "copyright_notice": null,
  "creator": null,
  "creator_url": null,
  "attribution_required": null,
  "attribution_text": null,
  "rights": {
    "rights_verified": false
  }
}
```

## Video search

```js
const videos = await crawler.videos("Ghana football training", {
  max_results: 12,
  safe_search: "moderate",
});
```

The free video path currently uses:

```
SearxNG videos, when configured
        |
        v
direct YouTube discovery fallback
```

Typical video result fields include:

- `video_url`
- `source_url`
- `thumbnail_url`
- creator/channel
- `creator_url`
- `duration_seconds`
- publication text
- view-count text
- provider provenance
- the same normalized rights metadata used for images

Crawler returns links to videos. It does not download or rehost video assets.

## Media rights and attribution

Crawler is **attribution-ready, not rights-cleared**.

For images and videos it normalizes whatever rights metadata the upstream source explicitly provides into:

- `license`
- `license_url`
- `copyright_status`
- `copyright_notice`
- `creator`
- `creator_url`
- `attribution_required`
- `attribution_text`
- `rights.rights_verified`
- `rights.verification_note`

Use the SDK helper:

```js
const rights = crawler.rights(images.results[0]);

console.log(rights.license);
console.log(rights.attribution_required);
console.log(rights.rights_verified);
```

Image requests can additionally set `rights` to:

- `any` — do not filter by rights metadata.
- `known` — require a source-supplied license/copyright signal.
- `no_attribution` — require known rights metadata explicitly indicating attribution is not required.
- `public_domain` — require a source claim such as public domain, CC0, or PDM.

These filters operate on source metadata; they do not convert `rights_verified=false` into legal verification.

Rules:

1. Crawler never treats search discovery as permission to reuse an asset.
2. Missing rights metadata stays `unknown` / `null`.
3. Explicit upstream CC0/public-domain or Creative Commons claims may be preserved.
4. `rights_verified=false` means the original `source_url` should still be checked before redistribution or publication.
5. Crawler should not invent an attribution string, creator, copyright owner, or license.

This distinction is intentional. An agent can know what metadata was discovered without confusing that metadata with a legal conclusion.

## Direct SDK functions

Existing callers can keep using the standalone functions:

```js
import {
  agentSearch,
  imageSearch,
  videoSearch,
  mediaRights,
} from "./sdk/agent-search.mjs";
```

They remain compatible with the earlier SDK calling style.

The SDK also exports:

- `AGENT_SEARCH_PROTOCOL`
- `CRAWLER_API_VERSION`
- `CrawlerApiError`

`CrawlerApiError` exposes `status`, `body`, and `endpoint` when the server returns an error.

## Agent search contract

Example raw request:

```json
{
  "protocol": "agent-search-v1",
  "query": "What happens when one asyncio TaskGroup task fails?",
  "intent": "technical",
  "goal": "explain",
  "entities": ["Python", "asyncio"],
  "concepts": ["TaskGroup", "task cancellation", "ExceptionGroup"],
  "source_policy": "primary",
  "preferred_domains": ["docs.python.org"],
  "required_evidence": ["TaskGroup", "cancel", "ExceptionGroup"],
  "depth": "deep",
  "max_results": 6,
  "crawl_budget": 4,
  "output": "passages"
}
```

Only `protocol` and `query` are mandatory at the HTTP layer. Agent callers should still send semantics they already know because that reduces redundant planning work and improves retrieval precision.

## Free vs hardened provider layer

The public contract is deliberately provider-independent.

Free tier:

```
cache / indexed corpus
  -> free web discovery
  -> free image discovery
  -> free video discovery
  -> best-effort provider reliability
```

A hardened paid tier can later replace or augment those providers with commercial search/media backends, retries, higher concurrency, stronger freshness, and tighter SLAs **without changing the SDK methods or endpoint shapes**.

That means agents can keep calling:

```js
crawler.search(...)
crawler.images(...)
crawler.videos(...)
```

while Crawler changes the provider strategy behind the API.

## Latency architecture

The structured web path is optimized for:

1. cached query/evidence lookup
2. known-domain corpus/sitemap
3. focused external discovery on a cold miss
4. parallel direct retrieval
5. deterministic evidence matching
6. immediate response
7. asynchronous indexing/enrichment afterward

Recent internal probes have demonstrated sub-second warm retrieval and roughly 2.5 seconds for an isolated structured cold-search case. Treat these as internal observations, not an SLA.

## Local run

```bash
cd web-search-api
npm install
npm start
```

Production integrations are configured through environment variables for MongoDB, AMQP, embedding infrastructure, discovery providers, and API authentication.

For the complete request contract, see [API.md](./API.md). For machine-readable integration, use `GET /openapi.json`.
