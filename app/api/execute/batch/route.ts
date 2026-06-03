import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// Finished states a job can be redone from
const REDOABLE = ["completed", "failed", "cancelled"];

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { projectId, redo } = body;

  const jobs = await convex.query(api.jobs.list, projectId ? { projectId } : {});

  if (redo) {
    // Re-run finished jobs from scratch — clears prior output/PR and re-queues
    const targets = jobs.filter((j) => REDOABLE.includes(j.status));
    for (const job of targets) {
      await convex.mutation(api.jobs.requeue, { id: job._id });
    }
    return NextResponse.json({ started: targets.length });
  }

  const pending = jobs.filter((j) => j.status === "pending");
  for (const job of pending) {
    await convex.mutation(api.jobs.updateStatus, { id: job._id, status: "queued" });
  }

  return NextResponse.json({ started: pending.length });
}
