import { runClaude } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPush } from "./worktree";
import { createPR } from "./github";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";

const convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
const running = new Map<string, AbortController>();

function log(jobId: Id<"jobs">, msg: string) {
  const line = `[factory] ${msg}\n`;
  convex.mutation(api.jobs.appendOutput, { jobId, text: line }).catch(() => {});
}

export async function startJob(jobId: Id<"jobs">) {
  if (running.has(jobId)) return;

  const job = await convex.query(api.jobs.get, { id: jobId });
  if (!job) return;
  const project = await convex.query(api.projects.get, { id: job.projectId });
  if (!project) return;

  const ac = new AbortController();
  running.set(jobId, ac);

  await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running" });
  log(jobId, `Job started — "${job.title}"`);
  log(jobId, `Repo: ${project.localPath}`);

  let worktreePath: string;
  let branch: string;

  try {
    log(jobId, "Creating git worktree…");
    const wt = createWorktree(project.localPath, jobId, project.defaultBranch);
    worktreePath = wt.worktreePath;
    branch = wt.branch;
    log(jobId, `Worktree ready: ${worktreePath}`);
    log(jobId, `Branch: ${branch}`);
  } catch (err) {
    running.delete(jobId);
    const msg = String(err);
    log(jobId, `ERROR: ${msg}`);
    await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
    return;
  }

  await convex.mutation(api.jobs.updateStatus, {
    id: jobId,
    status: "running",
    worktreePath,
    branch,
  });

  log(jobId, "Launching Claude Code CLI…");
  log(jobId, "─".repeat(40));

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
      log(jobId, "─".repeat(40));
      log(jobId, "Claude finished. Committing changes…");

      const changedFiles = getChangedFiles(worktreePath);
      log(jobId, `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`);

      try {
        if (changedFiles.length > 0) {
          commitAndPush(worktreePath, `feat: ${job.title}\n\nAutomated by Factory`);
          log(jobId, "Committed and pushed.");
        } else {
          log(jobId, "No changes to commit.");
        }

        const [owner, repo] = project.repo.split("/");
        let prUrl: string | undefined;
        let prNumber: number | undefined;

        if (project.githubToken && changedFiles.length > 0) {
          log(jobId, "Creating pull request…");
          const pr = await createPR(project.githubToken, owner, repo, {
            title: job.title,
            body: `## Changes\n${job.prompt}\n\nAutomated by Factory`,
            head: branch,
            base: project.defaultBranch,
            issueNumber: job.githubIssueNumber,
          });
          prUrl = pr.url;
          prNumber = pr.number;
          log(jobId, `PR created: ${prUrl}`);
        }

        await convex.mutation(api.jobs.updateStatus, {
          id: jobId,
          status: "completed",
          prUrl,
          prNumber,
          touchedPaths: changedFiles,
        });
        log(jobId, "✓ Job completed successfully.");
      } catch (err) {
        const msg = String(err);
        log(jobId, `ERROR during commit/push/PR: ${msg}`);
        await convex.mutation(api.jobs.updateStatus, {
          id: jobId,
          status: "failed",
          error: msg,
        });
      } finally {
        removeWorktree(project.localPath, worktreePath);
        log(jobId, "Worktree cleaned up.");
      }
    },
    onError: async (err) => {
      running.delete(jobId);
      log(jobId, "─".repeat(40));
      log(jobId, `ERROR: ${err}`);
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
