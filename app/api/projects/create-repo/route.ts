import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { createRepo } from "@/lib/github";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

// Creates a brand-new GitHub repo for the signed-in user, then clones it into
// the local workspace so the worker can spin up worktrees against it.
export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const token = session?.accessToken ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Sign in with GitHub to create a repo" }, { status: 401 });
  }

  const { name, description, private: isPrivate } = await req.json();
  if (!name?.trim()) return NextResponse.json({ error: "name required" }, { status: 400 });

  let repoInfo;
  try {
    repoInfo = await createRepo(token, name.trim(), description ?? "", isPrivate !== false);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create repo";
    const status = /already exists/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: message }, { status });
  }

  // On Vercel (or any serverless host) the filesystem is read-only apart from an
  // ephemeral /tmp, so we can't clone the repo onto disk here. The GitHub repo is
  // already created above; defer the actual clone to the local worker, which does
  // it lazily via ensureRepoCloned() into its own FACTORY_WORKSPACE on first job.
  if (process.env.VERCEL) {
    return NextResponse.json({
      repo: repoInfo.fullName,
      defaultBranch: repoInfo.defaultBranch,
      htmlUrl: repoInfo.htmlUrl,
      localPath: "", // worker clones into its own workspace by repo name
    });
  }

  const workspace = process.env.FACTORY_WORKSPACE ?? path.join(os.homedir(), "factory-workspace");
  const repoName = repoInfo.fullName.split("/")[1];
  const localPath = path.join(workspace, repoName);

  if (fs.existsSync(localPath)) {
    return NextResponse.json({
      repo: repoInfo.fullName,
      defaultBranch: repoInfo.defaultBranch,
      htmlUrl: repoInfo.htmlUrl,
      localPath,
      alreadyExists: true,
    });
  }

  const cloneUrl = `https://${token}@github.com/${repoInfo.fullName}.git`;
  try {
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    execSync(`git clone "${cloneUrl}" "${localPath}"`, { timeout: 120_000 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Clone failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({
    repo: repoInfo.fullName,
    defaultBranch: repoInfo.defaultBranch,
    htmlUrl: repoInfo.htmlUrl,
    localPath,
  });
}
