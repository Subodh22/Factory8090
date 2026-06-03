import { NextRequest, NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";
import { api } from "@/convex/_generated/api";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { projectId } = body;

  const jobs = await convex.query(api.jobs.list, projectId ? { projectId } : {});
  const pending = jobs.filter((j) => j.status === "pending");

  for (const job of pending) {
    await convex.mutation(api.jobs.updateStatus, { id: job._id, status: "queued" });
  }

  return NextResponse.json({ started: pending.length });
}
