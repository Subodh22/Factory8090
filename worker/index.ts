import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { startJob } from "../lib/queue";
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

const convex = new ConvexHttpClient(CONVEX_URL);

// Worker-level dedup — prevents launching the same job twice in one tick
const launching = new Set<string>();

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

async function tick() {
  try {
    // Pick up fresh queued jobs
    const queued = await convex.query(api.jobs.listByStatus, { status: "queued" });
    for (const job of queued) launch(job, "Starting");

    // Deliver user replies to waiting jobs
    const waiting = await convex.query(api.jobs.listByStatus, { status: "waiting_for_input" });
    for (const job of waiting) {
      if (!job.lastUserMessageAt) continue;
      const completedAt = job.completedAt ?? 0;
      if (job.lastUserMessageAt > completedAt) {
        launch(job, "User replied");
      }
    }
  } catch (err) {
    console.error(`[worker] tick error: ${err}`);
  }
}

tick();
const interval = setInterval(tick, 2000);

process.on("SIGINT", () => {
  clearInterval(interval);
  console.log("\n\n👋  Worker stopped.\n");
  process.exit(0);
});
