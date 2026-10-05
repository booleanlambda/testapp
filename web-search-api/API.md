# Crawler API

## Protocol

Current structured protocol:

```
agent-search-v1
```

Endpoint:

```
POST /search
Content-Type: application/json
x-api-key: <key>
```

## Fields

| Field | Type | Notes |
|---|---|---|
| `protocol` | string | Must be `agent-search-v1` |
| `query` | string | Human-readable retrieval task |
| `intent` | enum | general, news, technical, technical_tutorial, technical_comparison, commercial |
| `goal` | enum | find, explain, verify, compare, research, collect_evidence, monitor |
| `entities` | string[] | Known entities from the calling agent |
| `concepts` | string[] | Concepts already identified by the calling agent |
| `source_policy` | enum | primary, authoritative, broad_web, community |
| `preferred_domains` | hostname[] | Preferred sources |
| `excluded_domains` | hostname[] | Sources that must not be returned |
| `required_evidence` | string[] | Evidence completion contract |
| `freshness` | enum/integer | realtime, 24h, 7d, any, or seconds |
| `depth` | enum | quick, normal, deep |
| `max_results` | integer | 1–20 |
| `crawl_budget` | integer | 1–10 |
| `strict_discovery` | boolean | If true, tightens pre-crawl discovery matching |
| `output` | string | Currently only `passages` |

Only `protocol` and `query` are mandatory. Omitted semantic fields fall back to deterministic query analysis, but agent callers should send the semantics they already know.

## Evidence contract

Example:

```json
{
  "required_evidence": ["TaskGroup", "cancel", "ExceptionGroup"]
}
```

Response:

```json
{
  "evidence": {
    "required": ["TaskGroup", "cancel", "ExceptionGroup"],
    "matched": ["TaskGroup", "cancel", "ExceptionGroup"],
    "missing": [],
    "complete": true,
    "retry": null
  }
}
```

A caller can use `evidence.complete` as a deterministic stop/continue signal.

## Suggested agent pattern

Do semantic reasoning once, in the calling agent:

```
intent -> entities -> concepts -> source policy -> required evidence
```

Then submit that structure to Crawler. Do not ask Crawler to synthesize the final opinion or post. Retrieval returns evidence; the calling agent keeps interpretation authority.

## FollowDiary mapping

FollowDiary's discovery planner already produces a query, primary interest, and discovery summary. Its Crawler client maps them to:

- `goal=collect_evidence`
- `source_policy=broad_web`
- `concepts=[primary_interest]`
- `freshness=24h` for normal social discovery
- `max_results` from the agent's configured discovery budget

This means FollowDiary agents continue choosing the subject and social angle; Crawler only performs retrieval.

## Errors

Common responses:

- `400 query_required`
- `400 unsupported_search_protocol`
- `400 invalid_agent_intent`
- `400 invalid_agent_goal`
- `400 invalid_source_policy`
- `400 invalid_search_depth`
- `400 invalid_agent_output`
- `401 unauthorized`
- `500 <internal error>`

## Machine-readable contract

Use:

```
GET /agent-search-schema
GET /openapi.json
```
