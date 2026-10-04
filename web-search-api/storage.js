import { MongoClient } from "mongodb";
import { createHash } from "node:crypto";

let clientPromise;
let dbPromise;

export const sha256 = (value) =>
  createHash("sha256").update(String(value)).digest("hex");

export async function getDb() {
  if (!process.env.MONGODB_URI || !process.env.MONGODB_DB) {
    throw new Error("mongodb_not_configured");
  }
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
      connectTimeoutMS: 8000,
      family: 4
    });
    clientPromise = client.connect().then(() => client);
  }
  if (!dbPromise) {
    dbPromise = clientPromise.then((client) => client.db(process.env.MONGODB_DB));
  }
  return dbPromise;
}

export async function ensureIndexes() {
  const db = await getDb();
  await Promise.all([
    db.collection("documents").createIndex({ url: 1 }, { unique: true }),
    db.collection("documents").createIndex({ crawledAt: -1 }),
    db.collection("chunks").createIndex({ documentId: 1, ordinal: 1 }),
    db.collection("chunks").createIndex({ crawledAt: -1 }),
    db.collection("crawl_jobs").createIndex({ jobId: 1 }, { unique: true }),
    db.collection("crawl_jobs").createIndex({ createdAt: -1 }),
    db.collection("discovery_cache").createIndex({ key: 1 }, { unique: true }),
    db.collection("discovery_cache").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
  ]);
}

export async function createJob(job) {
  const db = await getDb();
  const now = new Date();
  await db.collection("crawl_jobs").insertOne({
    ...job,
    status: "queued",
    createdAt: now,
    updatedAt: now
  });
}

export async function updateJob(jobId, patch) {
  const db = await getDb();
  await db.collection("crawl_jobs").updateOne(
    { jobId },
    { $set: { ...patch, updatedAt: new Date() } }
  );
}

export async function getJob(jobId) {
  const db = await getDb();
  return db.collection("crawl_jobs").findOne(
    { jobId },
    { projection: { _id: 0 } }
  );
}

export async function savePage(page, chunks, embeddings, embeddingModel) {
  const db = await getDb();
  const documentId = sha256(page.url);
  const crawledAt = new Date();
  const contentHash = sha256(page.text);

  await db.collection("documents").updateOne(
    { url: page.url },
    {
      $set: {
        documentId,
        url: page.url,
        sourceUrl: page.sourceUrl || page.url,
        contentSourceUrl: page.contentSourceUrl || page.sourceUrl || page.url,
        extraction: page.extraction || "html",
        title: page.title || null,
        description: page.description || null,
        contentHash,
        wordCount: page.wordCount,
        statusCode: page.statusCode,
        contentType: page.contentType,
        crawledAt
      },
      $addToSet: {
        sourceUrls: page.sourceUrl || page.url
      },
      $setOnInsert: { createdAt: crawledAt }
    },
    { upsert: true }
  );

  await db.collection("chunks").deleteMany({ documentId });
  if (chunks.length) {
    await db.collection("chunks").insertMany(
      chunks.map((text, ordinal) => ({
        documentId,
        url: page.url,
        sourceUrl: page.sourceUrl || page.url,
        title: page.title || null,
        text,
        ordinal,
        embedding: embeddings?.[ordinal] || null,
        embeddingModel: embeddingModel || null,
        crawledAt
      })),
      { ordered: false }
    );
  }

  return { documentId, contentHash, chunkCount: chunks.length };
}

export async function recentChunks(limit = 1500, urls = null) {
  const db = await getDb();
  const filter = { embedding: { $type: "array" } };
  if (Array.isArray(urls) && urls.length) {
    filter.url = { $in: urls };
  }
  return db.collection("chunks")
    .find(
      filter,
      {
        projection: {
          _id: 0,
          documentId: 1,
          url: 1,
          title: 1,
          text: 1,
          ordinal: 1,
          embedding: 1,
          embeddingModel: 1,
          crawledAt: 1
        }
      }
    )
    .sort({ crawledAt: -1 })
    .limit(limit)
    .toArray();
}


export async function vectorSearchChunks(vector, options = {}) {
  if (!Array.isArray(vector) || !vector.length) {
    throw new Error("vector_required");
  }

  const db = await getDb();
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  const numCandidates = Math.max(
    limit,
    Math.min(Number(options.numCandidates || Math.max(limit * 20, 100)), 10000)
  );
  const index = process.env.VECTOR_INDEX_NAME?.trim() || "chunks_embedding_v2";
  const urls = Array.isArray(options.urls)
    ? [...new Set(options.urls.filter(Boolean))].slice(0, 100)
    : [];
  const embeddingModel = String(options.embeddingModel || "").trim();

  const filters = [];
  if (embeddingModel) filters.push({ embeddingModel });
  if (urls.length) filters.push({ url: { $in: urls } });

  const vectorSearch = {
    index,
    path: "embedding",
    queryVector: vector,
    numCandidates,
    limit
  };

  if (filters.length === 1) {
    vectorSearch.filter = filters[0];
  } else if (filters.length > 1) {
    vectorSearch.filter = { $and: filters };
  }

  return db.collection("chunks")
    .aggregate([
      { $vectorSearch: vectorSearch },
      {
        $project: {
          _id: 0,
          documentId: 1,
          url: 1,
          title: 1,
          text: 1,
          ordinal: 1,
          embeddingModel: 1,
          crawledAt: 1,
          vectorScore: { $meta: "vectorSearchScore" }
        }
      }
    ])
    .toArray();
}


export async function getDocument(url) {
  const db = await getDb();
  return db.collection("documents").findOne(
    { $or: [{ url }, { sourceUrl: url }, { sourceUrls: url }] },
    {
      projection: {
        _id: 0,
        documentId: 1,
        url: 1,
        title: 1,
        description: 1,
        sourceUrl: 1,
        sourceUrls: 1,
        extraction: 1,
        contentSourceUrl: 1,
        crawledAt: 1,
        wordCount: 1,
        contentHash: 1
      }
    }
  );
}

export async function getDiscoveryCache(key) {
  const db = await getDb();
  const row = await db.collection("discovery_cache").findOne(
    { key, expiresAt: { $gt: new Date() } },
    { projection: { _id: 0 } }
  );
  return row?.value || null;
}

export async function setDiscoveryCache(key, value, ttlSeconds = 600) {
  const db = await getDb();
  const now = new Date();
  const expiresAt = new Date(Date.now() + Math.max(30, ttlSeconds) * 1000);

  await db.collection("discovery_cache").updateOne(
    { key },
    {
      $set: {
        key,
        value,
        updatedAt: now,
        expiresAt
      },
      $setOnInsert: { createdAt: now }
    },
    { upsert: true }
  );
}
