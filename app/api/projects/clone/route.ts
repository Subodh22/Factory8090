import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const { repo, targetPath } = await req.json();

  if (!repo) return NextResponse.json({ error: "repo required" }, { status: 400 });

  const workspace = process.env.FACTORY_WORKSPACE ?? path.join(os.homedir(), "factory-workspace");
  const repoName = repo.split("/")[1];
  const localPath = targetPath || path.join(workspace, repoName);

  if (fs.existsSync(localPath)) {
    return NextResponse.json({ localPath, alreadyExists: true });
  }

  const token = session?.accessToken;
  const cloneUrl = token
    ? `https://${token}@github.com/${repo}.git`
    : `https://github.com/${repo}.git`;

  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    execSync(`git clone "${cloneUrl}" "${localPath}"`, { timeout: 120_000 });
    return NextResponse.json({ localPath });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Clone failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
