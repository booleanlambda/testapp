import http from "node:http";

const port = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      service: "web-search-api",
      status: "ready",
      mongoConfigured: Boolean(process.env.MONGODB_URI),
      nvidiaConfigured: Boolean(process.env.NVIDIA_API_KEY),
      amqpConfigured: Boolean(process.env.AMQP_URL)
    }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.log(`web-search-api listening on ${port}`);
});
