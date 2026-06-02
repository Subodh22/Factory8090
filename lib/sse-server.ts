import http from "http";

const subscribers = new Map<string, Set<http.ServerResponse>>();

export function broadcast(jobId: string, text: string) {
  const clients = subscribers.get(jobId);
  if (!clients?.size) return;
  const payload = `data: ${JSON.stringify({ text })}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

export function startSseServer(port = 3099): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Cache-Control");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "";

    const streamMatch = url.match(/^\/stream\/([^/?]+)/);
    if (req.method === "GET" && streamMatch) {
      const jobId = decodeURIComponent(streamMatch[1]);

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");

      if (!subscribers.has(jobId)) subscribers.set(jobId, new Set());
      subscribers.get(jobId)!.add(res);

      // Keep-alive ping every 15s so proxies don't close idle connections
      const heartbeat = setInterval(() => {
        try { res.write(": ping\n\n"); } catch { clearInterval(heartbeat); }
      }, 15_000);

      req.on("close", () => {
        clearInterval(heartbeat);
        const set = subscribers.get(jobId);
        if (set) {
          set.delete(res);
          if (set.size === 0) subscribers.delete(jobId);
        }
      });
      return;
    }

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, activeJobs: subscribers.size }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`📡  SSE server → http://localhost:${port}`);
  });

  return server;
}
