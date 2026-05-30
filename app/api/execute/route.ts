import { NextRequest, NextResponse } from "next/server";
import { startJob, cancelJob } from "@/lib/queue";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  startJob(jobId as Id<"jobs">).catch(async (err) => {
    console.error("[execute] startJob failed:", err);
    await convex.mutation(api.jobs.updateStatus, {
      id: jobId as Id<"jobs">,
      status: "failed",
      error: String(err),
    }).catch(() => {});
  });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  cancelJob(jobId as Id<"jobs">);
  return NextResponse.json({ ok: true });
}
