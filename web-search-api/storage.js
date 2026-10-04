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
    db.collection("crawl_jobs").createIndex({ createdAt: -1 })
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
        title: page.title || null,
        description: page.description || null,
        contentHash,
        wordCount: page.wordCount,
        statusCode: page.statusCode,
        contentType: page.contentType,
        crawledAt
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

export async function recentChunks(limit = 1500) {
  const db = await getDb();
  return db.collection("chunks")
    .find(
      { embedding: { $type: "array" } },
      {
        projection: {
          _id: 0,
          documentId: 1,
          url: 1,
          title: 1,
          text: 1,
          ordinal: 1,
          embedding: 1,
          crawledAt: 1
        }
      }
    )
    .sort({ crawledAt: -1 })
    .limit(limit)
    .toArray();
}
