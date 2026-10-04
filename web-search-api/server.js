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

async function testMongo() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) return { ok: false, reason: "not_configured" };

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000
  });

  try {
    await client.connect();
    await client.db(process.env.MONGODB_DB).command({ ping: 1 });
    return { ok: true };
  } catch {
    return { ok: false, reason: "connection_failed" };
  } finally {
    await client.close().catch(() => {});
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
    const [mongo, amqpStatus, embedding] = await Promise.all([
      testMongo(),
      testAmqp(),
      testEmbeddingEndpoint()
    ]);

    const ok = mongo.ok && amqpStatus.ok && embedding.ok;

    sendJson(res, ok ? 200 : 503, {
      service: "web-search-api",
      ok,
      mongo,
      amqp: amqpStatus,
      embedding
    });
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`web-search-api listening on ${port}`);
});
