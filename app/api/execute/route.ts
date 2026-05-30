import { NextRequest, NextResponse } from "next/server";
import { startJob, cancelJob } from "@/lib/queue";
import type { Id } from "@/convex/_generated/dataModel";

export async function POST(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });

  startJob(jobId as Id<"jobs">).catch(console.error);

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const { jobId } = await req.json();
  if (!jobId) return NextResponse.json({ error: "jobId required" }, { status: 400 });
  cancelJob(jobId as Id<"jobs">);
  return NextResponse.json({ ok: true });
}
