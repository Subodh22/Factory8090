import { NextRequest, NextResponse } from "next/server";
import { startJob } from "@/lib/queue";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST(req: NextRequest) {
  const { projectId } = await req.json();
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });

  const jobs = await convex.query(api.jobs.list, { projectId });
  const pending = jobs.filter((j) => j.status === "pending");

  for (const job of pending) {
    startJob(job._id as Id<"jobs">).catch((err) => {
      console.error(`[batch] job ${job._id} failed:`, err);
    });
  }

  return NextResponse.json({ started: pending.length });
}
