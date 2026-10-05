import http from "node:http";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import amqp from "amqplib";
import { crawlSite, validatePublicUrl } from "./crawler.js";
import { searchIndex } from "./search.js";
import { liveSearch } from "./live-search.js";
import { discoverWeb } from "./discovery.js";
import { AGENT_SEARCH_PROTOCOL, agentSearchSchema, parseAgentSearchRequest } from "./agent-request.js";
import {
  createJob,
  ensureIndexes,
  getJob,
  updateJob
} from "./storage.js";
import {
  embeddingDiagnostics,
  resolveEmbeddingModel
} from "./embedding.js";
import {
  initQueue,
  publishCrawlJob,
  queueState
} from "./queue.js";

const port = Number(process.env.PORT || 10000);

const envState = () => ({
  MONGODB_URI: Boolean(process.env.MONGODB_URI),
  MONGODB_DB: Boolean(process.env.MONGODB_DB),
  EMBEDDING_API_KEY: Boolean(process.env.EMBEDDING_API_KEY),
  EMBEDDING_BASE_URL: Boolean(process.env.EMBEDDING_BASE_URL),
  AMQP_URL: Boolean(process.env.AMQP_URL)
});

const withTimeout = async (promise, ms = 6000) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const redactMongoMessage = (message = "") =>
  String(message)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"']+/gi, "[redacted-mongodb-uri]")
    .replace(/([?&](?:password|passwd|pwd)=)[^&\s]+/gi, "$1[redacted]")
    .slice(0, 500);

async function testMongo() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) {
    return { ok: false, reason: "not_configured" };
  }

  let client;
  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 6000,
      connectTimeoutMS: 6000,
      family: 4
    });
    await client.connect();
    await client.db(process.env.MONGODB_DB).command({ ping: 1 });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "connection_failed",
      error: {
        name: error?.name || "Error",
        code: error?.code ?? null,
        message: redactMongoMessage(error?.message || String(error))
      }
    };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function testAmqp() {
  if (!process.env.AMQP_URL) return { ok: false, reason: "not_configured" };

  let connection;
  try {
    connection = await withTimeout(amqp.connect(process.env.AMQP_URL), 6000);
    return { ok: true };
  } catch {
    return { ok: false, reason: "connection_failed" };
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}

async function testEmbedding() {
  const state = embeddingDiagnostics();
  if (!state.configured) return { ok: false, reason: "not_configured" };

  try {
    const model = await withTimeout(resolveEmbeddingModel(), 8000);
    return {
      ok: true,
      reachable: true,
      model: model || null,
      dynamicModel: state.dynamicModel
    };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

async function runDiagnostics() {
  const environment = envState();
  const [mongo, amqpStatus, embedding] = await Promise.all([
    testMongo(),
    testAmqp(),
    testEmbedding()
  ]);

  return {
    environment,
    mongo,
    amqp: amqpStatus,
    embedding,
    queue: queueState(),
    ok:
      Object.values(environment).every(Boolean) &&
      mongo.ok &&
      amqpStatus.ok &&
      embedding.ok
  };
}

async function processCrawlJob(payload) {
  const { jobId, url, options } = payload;
  await updateJob(jobId, { status: "running", startedAt: new Date() });

  try {
    const result = await crawlSite(url, options);
    const status = result.indexedPages > 0 ? "complete" : "failed";
    await updateJob(jobId, {
      status,
      result,
      completedAt: new Date(),
      error: status === "failed" ? "no_pages_indexed" : null
    });
  } catch (error) {
    await updateJob(jobId, {
      status: "failed",
      error: String(error?.message || "crawl_failed").slice(0, 500),
      completedAt: new Date()
    });
    throw error;
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type,authorization,x-api-key",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  });
  res.end(JSON.stringify(body));
}

async function readJson(req, maxBytes = 65536) {
  let bytes = 0;
  const parts = [];
  for await (const part of req) {
    bytes += part.length;
    if (bytes > maxBytes) throw new Error("request_too_large");
    parts.push(part);
  }

  if (!parts.length) return {};
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch {
    throw new Error("invalid_json");
  }
}

function crawlOptions(body = {}) {
  return {
    maxPages: Math.max(1, Math.min(Number(body.maxPages || 1), 10)),
    depth: Math.max(0, Math.min(Number(body.depth || 0), 2)),
    sameOrigin: body.sameOrigin !== false,
    respectRobots: body.respectRobots !== false
  };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type,authorization,x-api-key",
        "access-control-allow-methods": "GET,POST,OPTIONS"
      });
      res.end();
      return;
    }

    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const path = requestUrl.pathname;

    if (req.method === "GET" && path === "/") {
      sendJson(res, 200, {
        service: "web-search-api",
        version: "0.5.1",
        endpoints: {
          health: "GET /health",
          diagnostics: "GET /diagnostics",
          crawl: "POST /crawl",
          crawlStatus: "GET /crawl/:jobId",
          search: "POST /search or GET /search?q=...",
          agentSearch: `POST /search with protocol=${AGENT_SEARCH_PROTOCOL}`,
          agentSchema: "GET /agent-search-schema",
          discover: "GET /discover?q=..."
        },
        limits: {
          crawlMaxPages: 10,
          crawlMaxDepth: 2,
          searchMaxResults: 20
        }
      });
      return;
    }

    if (req.method === "GET" && path === "/agent-search-schema") {
      sendJson(res, 200, agentSearchSchema());
      return;
    }

    if (req.method === "GET" && path === "/health") {
      const env = envState();
      const configured = Object.values(env).every(Boolean);
      sendJson(res, configured ? 200 : 503, {
        service: "web-search-api",
        status: configured ? "ready" : "missing_configuration",
        environment: env,
        queue: queueState()
      });
      return;
    }

    if (req.method === "GET" && path === "/diagnostics") {
      const diagnostics = await runDiagnostics();
      sendJson(res, diagnostics.ok ? 200 : 503, {
        service: "web-search-api",
        ...diagnostics
      });
      return;
    }

    if (req.method === "POST" && path === "/crawl") {
      const body = await readJson(req);
      if (!body.url) {
        sendJson(res, 400, { error: "url_required" });
        return;
      }

      const target = (await validatePublicUrl(body.url)).toString();
      const options = crawlOptions(body);
      const jobId = randomUUID();

      await createJob({
        jobId,
        url: target,
        options
      });

      if (body.wait === true) {
        try {
          await processCrawlJob({ jobId, url: target, options });
        } catch {}
        const job = await getJob(jobId);
        sendJson(res, job?.status === "complete" ? 200 : 502, job);
        return;
      }

      try {
        await publishCrawlJob({ jobId, url: target, options });
      } catch (error) {
        await updateJob(jobId, {
          status: "failed",
          error: error?.message || "queue_publish_failed"
        });
        throw error;
      }

      sendJson(res, 202, {
        jobId,
        status: "queued",
        url: target,
        statusUrl: `/crawl/${jobId}`
      });
      return;
    }

    if (req.method === "GET" && path.startsWith("/crawl/")) {
      const jobId = decodeURIComponent(path.slice("/crawl/".length));
      const job = await getJob(jobId);
      if (!job) {
        sendJson(res, 404, { error: "crawl_job_not_found" });
        return;
      }
      sendJson(res, 200, job);
      return;
    }

    if (req.method === "GET" && path === "/discover") {
      const query = requestUrl.searchParams.get("q");
      const limit = requestUrl.searchParams.get("limit") || 8;
      if (!query) {
        sendJson(res, 400, { error: "query_required" });
        return;
      }
      const result = await discoverWeb(query, { limit });
      sendJson(res, 200, result);
      return;
    }

    if ((req.method === "POST" || req.method === "GET") && path === "/search") {
      const body = req.method === "POST" ? await readJson(req) : {};
      if (body.protocol && body.protocol !== AGENT_SEARCH_PROTOCOL) {
        sendJson(res, 400, { error: "unsupported_search_protocol", supported: AGENT_SEARCH_PROTOCOL });
        return;
      }

      const structured = req.method === "POST" ? parseAgentSearchRequest(body) : null;
      const query = structured?.request.query || body.query || body.q || requestUrl.searchParams.get("q");
      const limit = structured?.request.limit || body.limit || requestUrl.searchParams.get("limit") || 5;
      const mode =
        body.mode ||
        requestUrl.searchParams.get("mode") ||
        (body.live === false ? "index" : "live");

      if (!query) {
        sendJson(res, 400, { error: "query_required" });
        return;
      }

      if (mode === "index") {
        const result = await searchIndex(query, { limit });
        sendJson(res, 200, { ...result, mode: "index" });
        return;
      }

      const result = await liveSearch(query, {
        limit,
        maxDiscover: structured?.request.maxDiscover || body.maxDiscover || requestUrl.searchParams.get("maxDiscover") || 8,
        maxCrawl: structured?.request.maxCrawl || body.maxCrawl || requestUrl.searchParams.get("maxCrawl") || 5,
        freshSeconds: structured?.request.freshSeconds || body.freshSeconds || requestUrl.searchParams.get("freshSeconds") || 1800,
        analysis: structured?.analysis || null,
        agentRequest: structured?.request || null
      });
      sendJson(res, 200, result);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    const message = String(error?.message || "internal_error");
    const clientErrors = new Set([
      "invalid_json",
      "request_too_large",
      "invalid_url",
      "unsupported_protocol",
      "private_host_blocked",
      "invalid_agent_intent",
      "invalid_agent_goal",
      "invalid_source_policy",
      "invalid_search_depth",
      "invalid_agent_output"
    ]);
    sendJson(res, clientErrors.has(message) ? 400 : 500, {
      error: message.slice(0, 500)
    });
  }
});

server.listen(port, "0.0.0.0", async () => {
  console.log(`web-search-api v0.5.1 listening on ${port}`);

  try {
    await ensureIndexes();
    console.log("mongo indexes ready");
  } catch (error) {
    console.error("mongo index bootstrap failed", error?.message || error);
  }

  try {
    const queue = await initQueue(processCrawlJob);
    console.log("crawl queue ready", queue.queue);
  } catch (error) {
    console.error("crawl queue bootstrap failed", error?.message || error);
  }

  const diagnostics = await runDiagnostics();
  console.log("startup diagnostics", JSON.stringify(diagnostics));



  (async () => {
    const startedAt = Date.now();
    const query = "Why does Postgres write full-page images after checkpoints, how can hint bits trigger them, and what does wal_compression change?";
    try {
      const result = await withTimeout(
        liveSearch(query, {
          limit: 10,
          maxDiscover: 10,
          maxCrawl: 5,
          freshSeconds: 60
        }),
        70000
      );

      const rankedRows = (result.results || []).filter((row) => row.fallback !== true);
      const evidence = rankedRows.map((row) => String(row.content || "")).join("\n").toLowerCase();
      const checks = {
        discovered: Number(result.discovery?.resultCount || 0) > 0,
        freshlyIndexed: Number(result.crawl?.indexed || 0) > 0,
        atlasRanked: rankedRows.length > 0,
        postgresSource: rankedRows.some((row) =>
          /postgresql\.org|github\.com\/postgres\/postgres/i.test(row.url || "")
        ),
        checkpoint: /checkpoint/.test(evidence),
        fullPage: /full[- ]page|full page image|full-page image/.test(evidence),
        hintBits: /hint bit|hint bits/.test(evidence),
        walCompression: /wal_compression|wal compression/.test(evidence)
      };

      const passed = Object.values(checks).every(Boolean);
      const payload = {
        name: "postgres_wal_internals_full_pipeline",
        query,
        passed,
        durationMs: Date.now() - startedAt,
        discovery: result.discovery,
        crawl: result.crawl,
        embeddingModel: result.embeddingModel,
        checks,
        results: (result.results || []).slice(0, 10).map((row) => ({
          title: row.title,
          url: row.url,
          score: row.score,
          semanticScore: row.semanticScore,
          lexicalScore: row.lexicalScore,
          fallback: row.fallback || false,
          excerpt: String(row.content || "").slice(0, 460)
        }))
      };

      if (passed) {
        console.log("RIGID_LIVE_PASS", JSON.stringify(payload));
      } else {
        console.error("RIGID_LIVE_FAIL", JSON.stringify(payload));
      }
    } catch (error) {
      console.error("RIGID_LIVE_FAIL", JSON.stringify({
        name: "postgres_wal_internals_full_pipeline",
        query,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      }));
    }
  })();

  (async () => {
    const startedAt = Date.now();
    const query = "In Node.js, why can recursive process.nextTick starve I/O, where do Promise callbacks and queueMicrotask run relative to nextTick, and when does setImmediate run relative to setTimeout(0) after an I/O callback?";
    try {
      const result = await withTimeout(
        liveSearch(query, {
          limit: 12,
          maxDiscover: 12,
          maxCrawl: 6,
          freshSeconds: 60
        }),
        80000
      );

      const rankedRows = (result.results || []).filter((row) => row.fallback !== true);
      const evidence = rankedRows.map((row) => String(row.content || "")).join("\n").toLowerCase();
      const checks = {
        discovered: Number(result.discovery?.resultCount || 0) > 0,
        technicalIntent: String(result.discovery?.intent || "").startsWith("technical"),
        freshlyIndexed: Number(result.crawl?.indexed || 0) > 0 || Number(result.crawl?.reused || 0) > 0,
        ranked: rankedRows.length > 0,
        officialNodeSource: rankedRows.some((row) => /(^|\.)nodejs\.org$/i.test((() => { try { return new URL(row.url || "").hostname; } catch { return ""; } })())),
        nextTick: /process\.nexttick|nexttick/.test(evidence),
        starvation: /starv|prevent.*i\/o|i\/o.*prevent|recursive/.test(evidence),
        microtask: /queuemicrotask|microtask/.test(evidence),
        promise: /promise/.test(evidence),
        setImmediate: /setimmediate/.test(evidence),
        setTimeout: /settimeout/.test(evidence),
        ioOrdering: /i\/o|poll phase|after.*i\/o|within an i\/o cycle|event loop/.test(evidence)
      };

      const passed = Object.values(checks).every(Boolean);
      const payload = {
        name: "node_event_loop_semantics_full_pipeline",
        query,
        passed,
        durationMs: Date.now() - startedAt,
        discovery: result.discovery,
        crawl: result.crawl,
        embeddingModel: result.embeddingModel,
        checks,
        results: (result.results || []).slice(0, 12).map((row) => ({
          title: row.title,
          url: row.url,
          score: row.score,
          semanticScore: row.semanticScore,
          lexicalScore: row.lexicalScore,
          fallback: row.fallback || false,
          excerpt: String(row.content || "").slice(0, 520)
        }))
      };

      if (passed) {
        console.log("RIGID_LIVE_PASS", JSON.stringify(payload));
      } else {
        console.error("RIGID_LIVE_FAIL", JSON.stringify(payload));
      }
    } catch (error) {
      console.error("RIGID_LIVE_FAIL", JSON.stringify({
        name: "node_event_loop_semantics_full_pipeline",
        query,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      }));
    }
  })();

  (async () => {
    const startedAt = Date.now();
    const query = "Why can Kubernetes Server-Side Apply return field conflicts, how are managedFields used, and what changes when force conflicts is enabled?";
    try {
      const result = await withTimeout(
        liveSearch(query, {
          limit: 10,
          maxDiscover: 10,
          maxCrawl: 5,
          freshSeconds: 60
        }),
        70000
      );

      const rankedRows = (result.results || []).filter((row) => row.fallback !== true);
      const evidence = rankedRows.map((row) => String(row.content || "")).join("\n").toLowerCase();
      const checks = {
        discovered: Number(result.discovery?.resultCount || 0) > 0,
        freshlyIndexed: Number(result.crawl?.indexed || 0) > 0 || Number(result.crawl?.reused || 0) > 0,
        atlasRanked: rankedRows.length > 0,
        kubernetesSource: rankedRows.some((row) => /kubernetes\.io/i.test(row.url || "")),
        serverSideApply: /server[- ]side apply|server-side apply/.test(evidence),
        managedFields: /managedfields|managed fields/.test(evidence),
        conflict: /conflict/.test(evidence),
        force: /force conflicts|force.*conflict|conflict.*force/.test(evidence)
      };

      const passed = Object.values(checks).every(Boolean);
      const payload = {
        name: "kubernetes_ssa_conflict_full_pipeline",
        query,
        passed,
        durationMs: Date.now() - startedAt,
        discovery: result.discovery,
        crawl: result.crawl,
        embeddingModel: result.embeddingModel,
        checks,
        results: (result.results || []).slice(0, 10).map((row) => ({
          title: row.title,
          url: row.url,
          score: row.score,
          semanticScore: row.semanticScore,
          lexicalScore: row.lexicalScore,
          fallback: row.fallback || false,
          excerpt: String(row.content || "").slice(0, 460)
        }))
      };

      if (passed) {
        console.log("RIGID_LIVE_PASS", JSON.stringify(payload));
      } else {
        console.error("RIGID_LIVE_FAIL", JSON.stringify(payload));
      }
    } catch (error) {
      console.error("RIGID_LIVE_FAIL", JSON.stringify({
        name: "kubernetes_ssa_conflict_full_pipeline",
        query,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      }));
    }
  })();

  (async () => {
    const startedAt = Date.now();
    const body = {
      protocol: AGENT_SEARCH_PROTOCOL,
      query: "What does copy-on-write mean for Redis forked background saves, and why can Transparent Huge Pages make latency spikes worse?",
      intent: "technical",
      goal: "explain",
      entities: ["Redis"],
      concepts: ["copy-on-write", "fork", "Transparent Huge Pages", "latency"],
      source_policy: "primary",
      preferred_domains: ["redis.io"],
      required_evidence: ["copy-on-write", "fork", "Transparent Huge Pages", "latency"],
      depth: "deep",
      max_results: 10,
      crawl_budget: 6
    };
    const structured = parseAgentSearchRequest(body);
    const query = structured.request.query;

    try {
      const result = await withTimeout(
        liveSearch(query, {
          limit: structured.request.limit,
          maxDiscover: structured.request.maxDiscover,
          maxCrawl: structured.request.maxCrawl,
          freshSeconds: 60,
          analysis: structured.analysis,
          agentRequest: structured.request
        }),
        70000
      );

      const rankedRows = (result.results || []).filter((row) => row.fallback !== true);
      const planner = result.discovery?.planner || {};
      const checks = {
        discovered: Number(result.discovery?.resultCount || 0) > 0,
        structuredPlanner: planner.provider === "agent-structured",
        noPlannerModel: planner.model == null,
        technicalIntent: String(result.discovery?.intent || "").startsWith("technical"),
        freshlyIndexed: Number(result.crawl?.indexed || 0) > 0 || Number(result.crawl?.reused || 0) > 0,
        ranked: rankedRows.length > 0,
        redisSource: rankedRows.some((row) => /(^|\.)redis\.io$/i.test((() => { try { return new URL(row.url || "").hostname; } catch { return ""; } })())),
        evidenceComplete: result.evidence?.complete === true
      };

      const passed = Object.values(checks).every(Boolean);
      const payload = {
        name: "redis_cow_thp_structured_agent_full_pipeline",
        query,
        passed,
        durationMs: Date.now() - startedAt,
        protocol: result.protocol,
        discovery: result.discovery,
        crawl: result.crawl,
        evidence: result.evidence,
        embeddingModel: result.embeddingModel,
        checks,
        results: (result.results || []).slice(0, 10).map((row) => ({
          title: row.title,
          url: row.url,
          score: row.score,
          semanticScore: row.semanticScore,
          lexicalScore: row.lexicalScore,
          fallback: row.fallback || false,
          excerpt: String(row.content || "").slice(0, 500)
        }))
      };

      if (passed) {
        console.log("RIGID_LIVE_PASS", JSON.stringify(payload));
      } else {
        console.error("RIGID_LIVE_FAIL", JSON.stringify(payload));
      }
    } catch (error) {
      console.error("RIGID_LIVE_FAIL", JSON.stringify({
        name: "redis_cow_thp_structured_agent_full_pipeline",
        query,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      }));
    }
  })();

  (async () => {
    const startedAt = Date.now();
    const query = "How do MongoDB Vector Search scalar and binary quantization differ in memory savings and accuracy tradeoffs?";
    try {
      const result = await withTimeout(
        searchIndex(query, { limit: 8, candidateLimit: 100, perDocument: 8 }),
        30000
      );
      const canonical = "https://www.mongodb.com/docs/vector-search/about/vector-quantization";
      const rows = (result.results || []).filter((row) => row.url === canonical);
      const evidence = rows.map((row) => String(row.content || "")).join("\n").toLowerCase();
      const checks = {
        canonical: rows.length > 0,
        scalar: /scalar/.test(evidence),
        binary: /binary/.test(evidence),
        memory: /memory|ram|in memory|disk/.test(evidence),
        accuracy: /accuracy|recall|trade-?off/.test(evidence)
      };
      const passed = Object.values(checks).every(Boolean);
      const payload = {
        name: "mongodb_quantization_answerability",
        query,
        passed,
        durationMs: Date.now() - startedAt,
        retrieval: result.retrieval,
        vectorIndex: result.vectorIndex,
        candidateCount: result.candidateCount,
        checks,
        results: rows.slice(0, 5).map((row) => ({
          url: row.url,
          score: row.score,
          semanticScore: row.semanticScore,
          excerpt: String(row.content || "").slice(0, 420)
        }))
      };
      if (passed) {
        console.log("RIGID_INDEX_PASS", JSON.stringify(payload));
      } else {
        console.error("RIGID_INDEX_FAIL", JSON.stringify(payload));
      }
    } catch (error) {
      console.error("RIGID_INDEX_FAIL", JSON.stringify({
        name: "mongodb_quantization_answerability",
        query,
        passed: false,
        durationMs: Date.now() - startedAt,
        error: error?.message || String(error)
      }));
    }
  })();

  (async () => {
    const tests = [
      {
        name: "mongodb_vector_docs",
        query: "MongoDB Community mongot vector search documentation",
        validate(result) {
          return (result.results || []).some((row) => {
            const hay = `${row.title || ""} ${row.snippet || ""}`.toLowerCase();
            return /mongodb\.com/i.test(row.url || "") && /mongot|vector search/.test(hay);
          });
        }
      },
      {
        name: "tavily_open_source_alternatives",
        query: "best open source alternatives to Tavily web search API for agents",
        validate(result) {
          const verified = (result.results || []).filter((row) =>
            row.provider === "github-repositories" &&
            row.verifiedComparison === true &&
            row.openSourceVerified === true &&
            row.categoryMatched === true
          );
          return result.intent === "technical_comparison" && verified.length >= 3;
        }
      }
    ];

    await Promise.all(tests.map(async (test) => {
      const startedAt = Date.now();
      try {
        const result = await withTimeout(
          discoverWeb(test.query, { limit: 5, cacheTtl: 30, maxMs: 26000, debug: true }),
          30000
        );
        const passed = Boolean(test.validate(result));
        const payload = {
          name: test.name,
          query: test.query,
          passed,
          durationMs: Date.now() - startedAt,
          intent: result.intent,
          provider: result.provider,
          attempts: result.attempts,
          results: (result.results || []).slice(0, 5).map((x) => ({
            title: x.title,
            url: x.url,
            provider: x.provider,
            relevance: x.relevance,
            verifiedComparison: x.verifiedComparison || false,
            openSourceVerified: x.openSourceVerified || false,
            categoryMatched: x.categoryMatched || false
          }))
        };

        if (passed) {
          console.log("RIGID_REGRESSION_PASS", JSON.stringify(payload));
        } else {
          console.error("RIGID_REGRESSION_FAIL", JSON.stringify(payload));
        }
      } catch (error) {
        console.error("RIGID_REGRESSION_FAIL", JSON.stringify({
          name: test.name,
          query: test.query,
          passed: false,
          durationMs: Date.now() - startedAt,
          error: error?.message || String(error)
        }));
      }
    }));
  })();
});
