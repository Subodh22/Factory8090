import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function resolveRepo(repoPath: string): string {
  const trimmed = repoPath.trim();
  // Windows absolute path (e.g. C:\...) should never be passed through path.resolve
  // on a non-Windows host — it would prepend the CWD and produce a garbage path.
  if (/^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed.replace(/\//g, path.sep);
  return path.resolve(trimmed);
}

export function createWorktree(repoPath: string, jobId: string, baseBranch: string): { worktreePath: string; branch: string } {
  const normalizedRepo = resolveRepo(repoPath);
  if (!fs.existsSync(normalizedRepo)) {
    throw new Error(`Repo path does not exist: ${normalizedRepo}`);
  }

  const branch = `job/${jobId}`;
  const worktreePath = path.join(normalizedRepo, ".worktrees", jobId);
  const worktreesDir = path.join(normalizedRepo, ".worktrees");

  try {
    fs.mkdirSync(worktreesDir, { recursive: true });
  } catch {
    // Fallback for Windows when fs.mkdirSync recursive fails
    spawnSync("powershell", ["-Command", `New-Item -ItemType Directory -Force -Path "${worktreesDir}"`], { stdio: "pipe" });
    if (!fs.existsSync(worktreesDir)) {
      throw new Error(`Failed to create worktrees directory: ${worktreesDir}`);
    }
  }

  let result = git(["worktree", "add", "-b", branch, worktreePath, baseBranch], normalizedRepo);

  if (result.status !== 0) {
    // Branch already exists — attach the worktree to the existing branch
    if (result.stderr.includes("already exists")) {
      result = git(["worktree", "add", worktreePath, branch], normalizedRepo);
    }
    if (result.status !== 0) {
      throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
    }
  }

  return { worktreePath, branch };
}

export function removeWorktree(repoPath: string, worktreePath: string) {
  try {
    git(["worktree", "remove", "--force", worktreePath], repoPath);
    git(["worktree", "prune"], repoPath);
  } catch {
    // ignore cleanup errors
  }
}

export function getChangedFiles(worktreePath: string): string[] {
  try {
    const result = execSync("git diff --name-only HEAD", { cwd: worktreePath, encoding: "utf8" });
    return result.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

export function commitAndPush(worktreePath: string, message: string) {
  git(["add", "-A"], worktreePath);
  const commit = git(["commit", "-m", message], worktreePath);
  if (commit.status !== 0 && !commit.stdout.includes("nothing to commit")) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  git(["push", "origin", "HEAD"], worktreePath);
}

/**
 * Commit all changes on the current worktree branch, then push them directly
 * to the repo's default branch — no PR needed.
 * Fetches latest remote first so the push fast-forwards cleanly.
 */
export function commitAndPushDirect(worktreePath: string, message: string, defaultBranch: string) {
  git(["add", "-A"], worktreePath);
  const commit = git(["commit", "-m", message], worktreePath);
  if (commit.status !== 0 && !commit.stdout.includes("nothing to commit")) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }

  // Bring in any new commits on the default branch before pushing
  git(["fetch", "origin", defaultBranch], worktreePath);
  const rebase = git(["rebase", `origin/${defaultBranch}`], worktreePath);
  if (rebase.status !== 0) {
    // Abort the rebase so the worktree stays clean
    git(["rebase", "--abort"], worktreePath);
    throw new Error(`rebase onto ${defaultBranch} failed (merge conflict): ${rebase.stderr}`);
  }

  const push = git(["push", "origin", `HEAD:${defaultBranch}`], worktreePath);
  if (push.status !== 0) {
    throw new Error(`push to ${defaultBranch} failed: ${push.stderr}`);
  }
}
