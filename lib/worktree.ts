import { execSync, spawnSync } from "child_process";
import path from "path";
import fs from "fs";

export function createWorktree(repoPath: string, jobId: string, baseBranch: string): { worktreePath: string; branch: string } {
  const branch = `job/${jobId}`;
  const worktreePath = path.join(repoPath, ".worktrees", jobId);

  fs.mkdirSync(path.join(repoPath, ".worktrees"), { recursive: true });

  spawnSync("git", ["worktree", "add", "-b", branch, worktreePath, baseBranch], {
    cwd: repoPath,
    stdio: "inherit",
  });

  return { worktreePath, branch };
}

export function removeWorktree(repoPath: string, worktreePath: string) {
  try {
    spawnSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
    spawnSync("git", ["worktree", "prune"], { cwd: repoPath });
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
  spawnSync("git", ["add", "-A"], { cwd: worktreePath });
  spawnSync("git", ["commit", "-m", message], { cwd: worktreePath });
  spawnSync("git", ["push", "origin", "HEAD"], { cwd: worktreePath });
}
