import { NextRequest, NextResponse } from "next/server";
import { fetchIssues } from "@/lib/github";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const repo = searchParams.get("repo");
  const token = searchParams.get("token") ?? process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    return NextResponse.json({ error: "repo and token required" }, { status: 400 });
  }

  const [owner, repoName] = repo.split("/");
  const issues = await fetchIssues(token, owner, repoName);
  return NextResponse.json({ issues });
}
