import amqp from "amqplib";

const QUEUE = process.env.CRAWL_QUEUE || "web-search.crawl.v1";

let connection;
let channel;

export async function initQueue(handler) {
  if (!process.env.AMQP_URL) throw new Error("amqp_not_configured");

  connection = await amqp.connect(process.env.AMQP_URL);
  channel = await connection.createChannel();
  await channel.assertQueue(QUEUE, { durable: true });
  channel.prefetch(2);

  await channel.consume(QUEUE, async (message) => {
    if (!message) return;

    try {
      const payload = JSON.parse(message.content.toString("utf8"));
      await handler(payload);
      channel.ack(message);
    } catch (error) {
      console.error("crawl worker failed", error?.message || error);
      channel.nack(message, false, false);
    }
  });

  connection.on("error", (error) => {
    console.error("amqp connection error", error?.message || error);
  });

  connection.on("close", () => {
    channel = null;
    connection = null;
    console.error("amqp connection closed");
  });

  return { queue: QUEUE };
}

export async function publishCrawlJob(payload) {
  if (!channel) throw new Error("queue_not_ready");
  const ok = channel.sendToQueue(
    QUEUE,
    Buffer.from(JSON.stringify(payload)),
    {
      persistent: true,
      contentType: "application/json",
      messageId: payload.jobId
    }
  );
  if (!ok) {
    await new Promise((resolve) => channel.once("drain", resolve));
  }
}

export function queueState() {
  return {
    configured: Boolean(process.env.AMQP_URL),
    ready: Boolean(channel),
    queue: QUEUE
  };
}
