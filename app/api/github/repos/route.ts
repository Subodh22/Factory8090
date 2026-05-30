import { NextRequest, NextResponse } from "next/server";
import { fetchUserRepos } from "@/lib/github";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token") ?? process.env.GITHUB_TOKEN;

  if (!token) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  try {
    const repos = await fetchUserRepos(token);
    return NextResponse.json({ repos });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
