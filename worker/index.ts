import { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { startJob, getActiveJobIds, reapCancelled } from "../lib/queue";
import { startSseServer } from "../lib/sse-server";
import fs from "fs";
import path from "path";

// Load .env.local so NEXT_PUBLIC_CONVEX_URL is available
const envPath = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

const CONVEX_URL = process.env.NEXT_PUBLIC_CONVEX_URL;
if (!CONVEX_URL) {
  console.error("❌  NEXT_PUBLIC_CONVEX_URL not set — check web/.env.local");
  process.exit(1);
}

// ConvexClient holds a WebSocket and PUSHES query results when matching rows
// change — so the worker can sleep until a job is actually queued instead of
// polling on a timer. It also exposes one-off query()/mutation() for the
// rehydrate/sweep paths below.
const convex = new ConvexClient(CONVEX_URL);

// Worker-level dedup — prevents launching the same job twice in one tick
const launching = new Set<string>();

const SSE_PORT = Number(process.env.WORKER_SSE_PORT ?? 3099);
startSseServer(SSE_PORT);

console.log("\n🏭  Factory Worker");
console.log(`📡  Convex: ${CONVEX_URL.slice(0, 40)}…`);
console.log("👁   Watching for queued jobs…\n");

function launch(job: { _id: string; title: string }, reason: string) {
  if (launching.has(job._id)) return;
  launching.add(job._id);
  const ts = new Date().toLocaleTimeString();
  console.log(`▶  [${ts}] ${reason}: "${job.title}"`);
  startJob(job._id as Id<"jobs">)
    .then(() => console.log(`✓  Done: "${job.title}"`))
    .catch((err) => console.error(`✗  Failed: "${job.title}" — ${err}`))
    .finally(() => launching.delete(job._id));
}

// Each subscription's callback fires once on subscribe (with the current value)
// and again every time a matching row changes — so these replace the old 2s
// poll entirely. The `launching` dedup in launch() makes repeated fires safe.

type JobRow = { _id: string; title: string; status: string; lastUserMessageAt?: number; completedAt?: number; sessionId?: string };

/** A user reply (or a fresh message to a finished job) bumps lastUserMessageAt
 *  above completedAt — deliver it by resuming the conversation. */
function maybeDeliverReply(job: JobRow) {
  if (!job.lastUserMessageAt) return;
  if (job.lastUserMessageAt <= (job.completedAt ?? 0)) return;
  // Finished jobs can only be resumed if we captured a session id; waiting
  // jobs always have a live session, so they're fine without one.
  if (job.status !== "waiting_for_input" && !job.sessionId) return;
  launch(job, "User replied");
}

function subscribe() {
  // Pick up fresh queued jobs the instant they appear.
  convex.onUpdate(api.jobs.listByStatus, { status: "queued" }, (jobs) => {
    for (const job of jobs) launch(job, "Starting");
  });

  // Deliver user replies to jobs awaiting input OR already finished. Chatting
  // with a "done" job continues the conversation by resuming its saved session.
  for (const status of ["waiting_for_input", "completed", "failed"] as const) {
    convex.onUpdate(api.jobs.listByStatus, { status }, (jobs) => {
      for (const job of jobs) maybeDeliverReply(job);
    });
  }

  // Stop any agents the user cut from the UI (status set to "cancelled").
  convex.onUpdate(api.jobs.listByStatus, { status: "cancelled" }, (jobs) => {
    const active = new Set(getActiveJobIds());
    const toReap = jobs.map((j) => j._id).filter((id) => active.has(id));
    if (toReap.length > 0) {
      for (const id of toReap) console.log(`■  Stopping cancelled job: ${id}`);
      reapCancelled(toReap);
    }
  });
}

async function rehydrate() {
  try {
    const running = await convex.query(api.jobs.listByStatus, { status: "running" });
    for (const job of running) {
      console.log(`♻  Requeuing orphaned running job: "${job.title}"`);
      await convex.mutation(api.jobs.updateStatus, { id: job._id as Id<"jobs">, status: "queued" });
    }
  } catch (err) {
    console.error(`[worker] rehydrate error: ${err}`);
  }
}

// Sweep for jobs stuck "running" that this worker isn't actually processing
// (e.g. a job started via the API route and then the request died).
async function sweepStuck() {
  try {
    const running = await convex.query(api.jobs.listByStatus, { status: "running" });
    const STUCK_MS = 10 * 60 * 1000; // 10 minutes with no completion = stuck
    const now = Date.now();
    for (const job of running) {
      if (launching.has(job._id)) continue; // actively launching
      const startedAt = (job as { startedAt?: number }).startedAt ?? 0;
      if (startedAt && now - startedAt > STUCK_MS) {
        console.log(`⚠  Stuck job detected (${Math.round((now - startedAt) / 60000)}m): "${job.title}" → requeuing`);
        await convex.mutation(api.jobs.updateStatus, { id: job._id as Id<"jobs">, status: "queued" });
      }
    }
  } catch (err) {
    console.error(`[worker] sweepStuck error: ${err}`);
  }
}

// Recover orphaned "running" jobs from a previous run, then open the live
// subscriptions. After this the worker is event-driven — it wakes only when
// Convex pushes a change, not on a timer.
rehydrate().then(() => subscribe());

// Stuck-job detection is inherently time-based (10 min with no completion), so
// it stays on a slow timer rather than a subscription — one query per minute.
const sweepInterval = setInterval(sweepStuck, 60_000);

process.on("SIGINT", () => {
  clearInterval(sweepInterval);
  convex.close();
  console.log("\n\n👋  Worker stopped.\n");
  process.exit(0);
});
