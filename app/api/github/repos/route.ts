import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { fetchUserRepos } from "@/lib/github";

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const token = session?.accessToken ?? new URL(req.url).searchParams.get("token") ?? process.env.GITHUB_TOKEN;

  if (!token) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  try {
    const repos = await fetchUserRepos(token);
    return NextResponse.json({ repos });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to fetch repos";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
