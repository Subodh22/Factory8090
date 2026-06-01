import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

function git(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

export function createWorktree(repoPath: string, jobId: string, baseBranch: string): { worktreePath: string; branch: string } {
  const branch = `job/${jobId}`;
  const worktreePath = path.join(repoPath, ".worktrees", jobId);

  fs.mkdirSync(path.join(repoPath, ".worktrees"), { recursive: true });

  const result = git(["worktree", "add", "-b", branch, worktreePath, baseBranch], repoPath);

  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
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
