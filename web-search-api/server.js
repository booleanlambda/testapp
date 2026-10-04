import http from "node:http";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import amqp from "amqplib";
import { crawlSite, validatePublicUrl } from "./crawler.js";
import { searchIndex } from "./search.js";
import { liveSearch } from "./live-search.js";
import { discoverWeb } from "./discovery.js";
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
        version: "0.3.0",
        endpoints: {
          health: "GET /health",
          diagnostics: "GET /diagnostics",
          crawl: "POST /crawl",
          crawlStatus: "GET /crawl/:jobId",
          search: "POST /search or GET /search?q=...",
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
      const query = body.query || body.q || requestUrl.searchParams.get("q");
      const limit = body.limit || requestUrl.searchParams.get("limit") || 5;
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
        maxDiscover: body.maxDiscover || requestUrl.searchParams.get("maxDiscover") || 8,
        maxCrawl: body.maxCrawl || requestUrl.searchParams.get("maxCrawl") || 5,
        freshSeconds: body.freshSeconds || requestUrl.searchParams.get("freshSeconds") || 1800
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
      "private_host_blocked"
    ]);
    sendJson(res, clientErrors.has(message) ? 400 : 500, {
      error: message.slice(0, 500)
    });
  }
});

server.listen(port, "0.0.0.0", async () => {
  console.log(`web-search-api v0.3.0 listening on ${port}`);

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
});
