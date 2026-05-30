import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

const shell = process.platform === "win32";

export function createWorktree(repoPath: string, jobId: string, baseBranch: string): { worktreePath: string; branch: string } {
  const branch = `job/${jobId}`;
  const worktreePath = path.join(repoPath, ".worktrees", jobId);

  fs.mkdirSync(path.join(repoPath, ".worktrees"), { recursive: true });

  const result = spawnSync("git", ["worktree", "add", "-b", branch, worktreePath, baseBranch], {
    cwd: repoPath,
    stdio: "pipe",
    shell,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr || result.stdout}`);
  }

  return { worktreePath, branch };
}

export function removeWorktree(repoPath: string, worktreePath: string) {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath, shell });
    spawnSync("git", ["worktree", "prune"], { cwd: repoPath, shell });
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
  spawnSync("git", ["add", "-A"], { cwd: worktreePath, shell });
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: worktreePath, shell, encoding: "utf8" });
  if (commit.status !== 0 && !commit.stdout?.includes("nothing to commit")) {
    throw new Error(`git commit failed: ${commit.stderr}`);
  }
  spawnSync("git", ["push", "origin", "HEAD"], { cwd: worktreePath, shell });
}
