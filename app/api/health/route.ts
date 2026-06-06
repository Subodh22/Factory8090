import { NextResponse } from "next/server";
import { ConvexHttpClient } from "convex/browser";

export async function GET() {
  const checks: Record<string, "ok" | "error"> = {};

  // Convex connectivity
  try {
    const client = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
    // A lightweight read — list with no filters returns quickly
    await client.query((await import("@/convex/_generated/api")).api.projects.list);
    checks.convex = "ok";
  } catch {
    checks.convex = "error";
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  return NextResponse.json(
    { status: allOk ? "healthy" : "degraded", checks },
    { status: allOk ? 200 : 503 },
  );
}
