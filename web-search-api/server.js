import http from "node:http";
import { MongoClient } from "mongodb";
import amqp from "amqplib";

const port = Number(process.env.PORT || 10000);

const envState = () => ({
  MONGODB_URI: Boolean(process.env.MONGODB_URI),
  MONGODB_DB: Boolean(process.env.MONGODB_DB),
  EMBEDDING_API_KEY: Boolean(process.env.EMBEDDING_API_KEY),
  EMBEDDING_BASE_URL: Boolean(process.env.EMBEDDING_BASE_URL),
  AMQP_URL: Boolean(process.env.AMQP_URL)
});

const withTimeout = async (promise, ms = 5000) => {
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

const safeMongoError = (error) => ({
  name: error?.name || "Error",
  code: error?.code ?? null,
  codeName: error?.codeName ?? null,
  message: redactMongoMessage(error?.message || String(error))
});

async function testMongo() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) return { ok: false, reason: "not_configured" };

  let client;
  try {
    client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000
    });
    await client.connect();
    await client.db(process.env.MONGODB_DB).command({ ping: 1 });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: "connection_failed",
      error: safeMongoError(error)
    };
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

async function testAmqp() {
  if (!process.env.AMQP_URL) return { ok: false, reason: "not_configured" };

  let connection;
  try {
    connection = await withTimeout(amqp.connect(process.env.AMQP_URL), 5000);
    return { ok: true };
  } catch {
    return { ok: false, reason: "connection_failed" };
  } finally {
    if (connection) await connection.close().catch(() => {});
  }
}

async function testEmbeddingEndpoint() {
  if (!process.env.EMBEDDING_BASE_URL || !process.env.EMBEDDING_API_KEY) {
    return { ok: false, reason: "not_configured" };
  }

  try {
    const url = new URL(process.env.EMBEDDING_BASE_URL);
    const response = await withTimeout(fetch(url, {
      method: "HEAD",
      redirect: "manual"
    }), 5000);

    return {
      ok: true,
      reachable: true,
      httpStatus: response.status
    };
  } catch {
    return { ok: false, reason: "unreachable_or_invalid_url" };
  }
}

async function runDiagnostics() {
  const environment = envState();
  const [mongo, amqpStatus, embedding] = await Promise.all([
    testMongo(),
    testAmqp(),
    testEmbeddingEndpoint()
  ]);

  return {
    environment,
    mongo,
    amqp: amqpStatus,
    embedding,
    ok:
      Object.values(environment).every(Boolean) &&
      mongo.ok &&
      amqpStatus.ok &&
      embedding.ok
  };
}

const sendJson = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/health") {
    const env = envState();
    const configured = Object.values(env).every(Boolean);

    sendJson(res, configured ? 200 : 503, {
      service: "web-search-api",
      status: configured ? "configured" : "missing_configuration",
      environment: env
    });
    return;
  }

  if (req.url === "/diagnostics") {
    const diagnostics = await runDiagnostics();
    sendJson(res, diagnostics.ok ? 200 : 503, {
      service: "web-search-api",
      ...diagnostics
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", async () => {
  console.log(`web-search-api listening on ${port}`);

  const diagnostics = await runDiagnostics();
  console.log("startup diagnostics", JSON.stringify(diagnostics));
});
