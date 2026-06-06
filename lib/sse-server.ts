import http from "http";
import { spawn, type ChildProcess } from "child_process";

const subscribers = new Map<string, Set<http.ServerResponse>>();

// Live terminal commands keyed by their stream/session id, so a kill request
// can find and stop the right child process.
const terminalProcs = new Map<string, ChildProcess>();

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

// A chat message (a full assistant or user turn) sent as a NAMED `chat` SSE
// event so the browser can render it as a bubble in the chat thread, separate
// from the raw terminal `data:` stream. Ephemeral — never persisted.
export function broadcastChat(jobId: string, msg: { role: "assistant" | "user"; text: string; images?: string[] }) {
  const clients = subscribers.get(jobId);
  if (!clients?.size) return;
  const payload = `event: chat\ndata: ${JSON.stringify(msg)}\n\n`;
  for (const res of [...clients]) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// The worker registers a handler that delivers a user reply to the live (or
// resumable) Claude session for a job. Returns true if the reply was accepted
// (a session exists or can be resumed), false otherwise. Kept as a settable
// hook so sse-server doesn't import queue.ts (which imports this file).
type ReplyHandler = (jobId: string, text: string, images: string[]) => boolean | Promise<boolean>;
let replyHandler: ReplyHandler | null = null;
export function registerReplyHandler(fn: ReplyHandler) {
  replyHandler = fn;
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

// Run one shell command in `cwd`, streaming stdout/stderr to subscribers of
// `sessionId`. The browser opens an EventSource on /stream/<sessionId> first,
// then POSTs here. stderr chunks and the final exit code use \x00-markers the
// UI colour-codes, mirroring the convention claude-runner.ts uses.
function runTerminalCommand(sessionId: string, cwd: string, command: string) {
  const existing = terminalProcs.get(sessionId);
  if (existing) {
    try { existing.kill(); } catch { /* already gone */ }
  }

  let child: ChildProcess;
  try {
    child = spawn(command, { cwd, shell: true, env: process.env });
  } catch (err) {
    broadcast(sessionId, `\x00stderr\x00${(err as Error).message}\n`);
    broadcast(sessionId, `\x00exit\x001`);
    return;
  }

  terminalProcs.set(sessionId, child);
  child.stdout?.on("data", (d: Buffer) => broadcast(sessionId, d.toString()));
  child.stderr?.on("data", (d: Buffer) => broadcast(sessionId, `\x00stderr\x00${d.toString()}`));
  child.on("error", (err) => broadcast(sessionId, `\x00stderr\x00${err.message}\n`));
  child.on("close", (code) => {
    terminalProcs.delete(sessionId);
    broadcast(sessionId, `\x00exit\x00${code ?? 0}`);
  });
}

export function startSseServer(port = 3099): http.Server {
  const server = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Cache-Control, Content-Type");

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

    // Deliver a chat reply from the browser straight to the worker's live
    // Claude session — bypassing Convex entirely so chat is never persisted.
    // The browser should already be subscribed to /stream/<jobId> to see the
    // streamed response. Body: { text, images? }.
    const replyMatch = url.match(/^\/reply\/([^/?]+)/);
    if (req.method === "POST" && replyMatch) {
      const jobId = decodeURIComponent(replyMatch[1]);
      readJsonBody(req)
        .then(async (body) => {
          const text = String(body.text ?? "").trim();
          const images = Array.isArray(body.images) ? (body.images as string[]) : [];
          if (!text && !images.length) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "text or images required" }));
            return;
          }
          if (!replyHandler) {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "worker not ready" }));
            return;
          }
          const accepted = await replyHandler(jobId, text, images);
          if (!accepted) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "no live session for this job" }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      return;
    }

    // Run a shell command for an interactive terminal session. The browser must
    // already be subscribed to /stream/<sessionId> to receive the output.
    if (req.method === "POST" && url === "/terminal/exec") {
      readJsonBody(req)
        .then((body) => {
          const sessionId = String(body.sessionId ?? "");
          const cwd = String(body.cwd ?? "");
          const command = String(body.command ?? "");
          if (!sessionId || !cwd || !command) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "sessionId, cwd and command are required" }));
            return;
          }
          runTerminalCommand(sessionId, cwd, command);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        })
        .catch((err) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        });
      return;
    }

    // Stop the command currently running for a terminal session.
    if (req.method === "POST" && url === "/terminal/kill") {
      readJsonBody(req)
        .then((body) => {
          const sessionId = String(body.sessionId ?? "");
          const child = terminalProcs.get(sessionId);
          if (child) {
            try { child.kill(); } catch { /* already gone */ }
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, killed: Boolean(child) }));
        })
        .catch((err) => {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
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
