# Crawler — Agent Search API

Crawler is a low-latency web retrieval service designed for autonomous agents.

Instead of asking the search service to re-interpret an already-understood task, the calling agent sends a structured search contract. Crawler then performs deterministic discovery, direct retrieval, ranking, and evidence validation.

## Core idea

```
agent reasoning
  -> agent-search-v1 request
  -> cache/corpus/discovery
  -> direct page fetch
  -> evidence validation
  -> ranked passages
```

For structured requests, Crawler does not need an LLM planner in the response path. Embedding/index enrichment is also kept off the response-critical path.

## Live service

- Health: `GET /health`
- Agent schema: `GET /agent-search-schema`
- OpenAPI: `GET /openapi.json`
- Search: `POST /search`
- Images: `GET /images?q=...` or `POST /images`
- Videos: `GET /videos?q=...` or `POST /videos`

The current Render deployment is configured separately from this repository. Do not commit API keys or infrastructure secrets.

## Authentication

When `SEARCH_API_KEY` or `SEARCH_API_KEYS` is configured, all non-public endpoints require either:

```
x-api-key: <key>
```

or:

```
Authorization: Bearer <key>
```

Public endpoints remain available without authentication:

- `/`
- `/health`
- `/agent-search-schema`
- `/openapi.json`

If no API key is configured, protected endpoints remain open for local development.

## Structured agent request

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

The important field is `required_evidence`. Crawler checks the fetched material and reports which evidence terms were matched or remain missing.

## Response behavior

A structured response includes:

- ranked `results`
- `discovery` diagnostics and source provenance
- `evidence.required`, `matched`, `missing`, and `complete`
- `fastPath` metadata
- `crawl` activity
- planner metadata showing whether the caller supplied the semantics

For `agent-search-v1`, the planner provider is `agent-structured` and the planner model is `null`.

## Latency architecture

The structured path is optimized for:

1. cached query/evidence lookup,
2. known-domain corpus/sitemap,
3. focused external discovery on cold miss,
4. parallel direct fetch,
5. direct evidence matching,
6. immediate response,
7. asynchronous indexing/enrichment afterward.

Recent internal benchmarks reached sub-second warm retrieval and approximately 2.5 seconds for an isolated cold structured search.


## Image search

Crawler v0.7 adds first-class image discovery without putting an image generator in the retrieval path.

```
GET /images?q=Accra+skyline&limit=12
```

or:

```json
{
  "query": "Accra skyline at night",
  "max_results": 12,
  "safe_search": "moderate",
  "aspect": "wide",
  "min_width": 900,
  "min_height": 500,
  "preferred_domains": [],
  "excluded_domains": []
}
```

The free path uses SearxNG image results when configured and Bing Images HTML as the fallback. Responses return the direct image URL, thumbnail URL, source page, dimensions when available, provider provenance, and a rights status.

Crawler does **not** infer permission to reuse an image. Media results expose a normalized `rights` object with `license`, `license_url`, `copyright_status`, `copyright_notice`, creator fields, attribution fields, and `rights_verified`. Explicit upstream Creative Commons/public-domain claims can populate those fields, but `rights_verified=false` means the source page still needs verification before reuse or redistribution. A hardened paid provider can later be added behind the same contract without changing clients.

## Video search

Crawler v0.8 adds first-class video discovery:

```
GET /videos?q=Ghana+football&limit=12
```

The free path uses SearxNG video results when configured and direct YouTube discovery as a fallback. Results return the canonical video page, thumbnail, creator/channel, duration when available, publication/view text, provider provenance, and the same normalized rights metadata used for images.

Crawler links to videos; it does not download or rehost them.

## Local run

```bash
cd web-search-api
npm install
npm start
```

Required production services are configured by environment variables for MongoDB, AMQP, and the dynamic embedding provider.

## SDK

A dependency-free Node client is provided at:

```
sdk/agent-search.mjs
```

See [API.md](./API.md) for the request contract and integration guidance.
