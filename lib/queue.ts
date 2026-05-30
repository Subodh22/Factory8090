// In-memory job runner. Convex is source of truth for state;
// this module manages the actual execution lifecycle.

import { runClaude } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPush } from "./worktree";
import { createPR } from "./github";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);

// jobId → abort controller
const running = new Map<string, AbortController>();

export async function startJob(jobId: Id<"jobs">) {
  if (running.has(jobId)) return;

  const job = await convex.query(api.jobs.get, { id: jobId });
  if (!job) return;
  const project = await convex.query(api.projects.get, { id: job.projectId });
  if (!project) return;

  const ac = new AbortController();
  running.set(jobId, ac);

  await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running" });

  const { worktreePath, branch } = createWorktree(project.localPath, jobId, project.defaultBranch);

  await convex.mutation(api.jobs.updateStatus, {
    id: jobId,
    status: "running",
    worktreePath,
    branch,
  });

  const onChunk = (text: string) => {
    convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
  };

  runClaude({
    prompt: job.prompt,
    cwd: worktreePath,
    images: job.images,
    agentRules: project.agentRules,
    signal: ac.signal,
    onChunk,
    onDone: async () => {
      running.delete(jobId);
      const changedFiles = getChangedFiles(worktreePath);

      try {
        commitAndPush(worktreePath, `feat: ${job.title}\n\nAutomated by Factory`);

        const [owner, repo] = project.repo.split("/");
        let prUrl: string | undefined;
        let prNumber: number | undefined;

        if (project.githubToken) {
          const pr = await createPR(project.githubToken, owner, repo, {
            title: job.title,
            body: `## Changes\n${job.prompt}\n\nAutomated by Factory`,
            head: branch,
            base: project.defaultBranch,
            issueNumber: job.githubIssueNumber,
          });
          prUrl = pr.url;
          prNumber = pr.number;
        }

        await convex.mutation(api.jobs.updateStatus, {
          id: jobId,
          status: "completed",
          prUrl,
          prNumber,
          touchedPaths: changedFiles,
        });
      } catch (err) {
        await convex.mutation(api.jobs.updateStatus, {
          id: jobId,
          status: "failed",
          error: String(err),
        });
      } finally {
        removeWorktree(project.localPath, worktreePath);
      }
    },
    onError: async (err) => {
      running.delete(jobId);
      await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: err });
      removeWorktree(project.localPath, worktreePath);
    },
  });
}

export function cancelJob(jobId: Id<"jobs">) {
  const ac = running.get(jobId);
  if (ac) {
    ac.abort();
    running.delete(jobId);
  }
}

export function getRunningJobs(): string[] {
  return Array.from(running.keys());
}
