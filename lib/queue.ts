import { runClaude } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPush } from "./worktree";
import { createPR } from "./github";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import fs from "fs";

let _convex: ConvexHttpClient | null = null;
function getConvex(): ConvexHttpClient {
  if (!_convex) _convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  return _convex;
}

const running = new Map<string, AbortController>();

function log(jobId: Id<"jobs">, msg: string) {
  const line = `[factory] ${msg}\n`;
  getConvex().mutation(api.jobs.appendOutput, { jobId, text: line }).catch(() => {});
}

async function withRetry<T>(fn: () => Promise<T>, retries = 3, delayMs = 1000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error("unreachable");
}

export async function startJob(jobId: Id<"jobs">) {
  if (running.has(jobId)) return;

  const convex = getConvex();
  let worktreePath: string | undefined;

  try {
    const job = await withRetry(() => convex.query(api.jobs.get, { id: jobId }));
    if (!job) return;
    const project = await withRetry(() => convex.query(api.projects.get, { id: job.projectId }));
    if (!project) return;

    const ac = new AbortController();
    running.set(jobId, ac);

    await withRetry(() => convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running" }));
    log(jobId, `Job started — "${job.title}"`);

    // ── Worktree: resume existing or create new ──────────────────────────────
    let branch: string;
    let isResume = false;

    const existingWorktree = job.worktreePath && fs.existsSync(job.worktreePath);

    if (job.sessionId && existingWorktree) {
      worktreePath = job.worktreePath!;
      branch = job.branch!;
      isResume = true;
      log(jobId, `Resuming session in ${worktreePath}`);
    } else {
      log(jobId, `Repo: ${project.localPath}`);
      log(jobId, "Creating git worktree…");
      const wt = createWorktree(project.localPath, jobId, project.defaultBranch);
      worktreePath = wt.worktreePath;
      branch = wt.branch;
      log(jobId, `Worktree ready: ${worktreePath}`);
      log(jobId, `Branch: ${branch}`);
      await withRetry(() =>
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", worktreePath, branch })
      );
    }

    // ── Build prompt ─────────────────────────────────────────────────────────
    let messages: { role: "assistant" | "user"; text: string }[] = [];
    try {
      messages = await withRetry(() => convex.query(api.jobs.listMessages, { jobId }));
    } catch {
      // Non-fatal — continue with empty history
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const effectivePrompt = isResume && lastUserMessage ? lastUserMessage.text : job.prompt;

    if (isResume) log(jobId, `Continuing conversation…`);

    log(jobId, "Launching Claude Code CLI…");
    log(jobId, "─".repeat(40));

    let sessionId = job.sessionId;
    let claudeOutput = "";
    let assistantText = ""; // text from assistant message content blocks
    let resultText = "";    // text from the final result event

    const onChunk = (text: string) => {
      claudeOutput += text;
      convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
    };

    runClaude({
      prompt: effectivePrompt,
      cwd: worktreePath,
      images: isResume ? [] : job.images,
      agentRules: isResume ? undefined : project.agentRules,
      resumeSessionId: isResume ? sessionId! : undefined,
      signal: ac.signal,
      onChunk,
      onAssistantText: (text) => { assistantText += text; },
      onResult: (text) => { resultText = text; },
      onSessionId: (id) => {
        sessionId = id;
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", sessionId: id }).catch(() => {});
      },
      onDone: async () => {
        running.delete(jobId);
        log(jobId, "─".repeat(40));

        const changedFiles = getChangedFiles(worktreePath!);
        log(jobId, `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`);

        // If Claude made no changes, keep the session alive for follow-up
        // Don't try to detect "?" — Claude phrases questions many different ways
        const claudeResponse = assistantText.trim() || resultText.trim();
        if (changedFiles.length === 0) {
          log(jobId, "⏳ Waiting for your reply…");
          if (claudeResponse) {
            await convex.mutation(api.jobs.addMessage, { jobId, role: "assistant", text: claudeResponse });
          }
          await convex.mutation(api.jobs.updateStatus, {
            id: jobId,
            status: "waiting_for_input",
            sessionId: sessionId ?? undefined,
          });
          log(jobId, "Reply in the chat panel to continue.");
          return;
        }

        // Normal completion ───────────────────────────────────────────────────
        try {
          if (changedFiles.length > 0) {
            commitAndPush(worktreePath!, `feat: ${job.title}\n\nAutomated by Factory`);
            log(jobId, "Committed and pushed.");
          } else {
            log(jobId, "No changes to commit.");
          }

          const [owner, repo] = project.repo.split("/");
          let prUrl: string | undefined;
          let prNumber: number | undefined;

          if (project.githubToken && changedFiles.length > 0) {
            log(jobId, "Creating pull request…");
            try {
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
            } catch (prErr) {
              log(jobId, `Note: ${prErr} (PR may already exist)`);
            }
          }

          await withRetry(() =>
            convex.mutation(api.jobs.updateStatus, {
              id: jobId,
              status: "completed",
              prUrl,
              prNumber,
              touchedPaths: changedFiles,
              sessionId: sessionId ?? undefined,
            })
          );
          log(jobId, "✓ Job completed successfully.");
        } catch (err) {
          const msg = String(err);
          log(jobId, `ERROR during commit/push/PR: ${msg}`);
          await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
        } finally {
          removeWorktree(project.localPath, worktreePath!);
          log(jobId, "Worktree cleaned up.");
        }
      },
      onError: async (err) => {
        running.delete(jobId);
        log(jobId, "─".repeat(40));
        log(jobId, `ERROR: ${err}`);
        await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: err });
        removeWorktree(project.localPath, worktreePath!);
      },
    });
  } catch (err) {
    // Top-level catch — marks job failed and cleans up so it never gets stuck
    running.delete(jobId);
    const msg = String(err);
    console.error(`[startJob] unhandled error for ${jobId}: ${msg}`);
    try {
      log(jobId, `FATAL: ${msg}`);
      await getConvex().mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
    } catch { /* ignore — best effort */ }
    if (worktreePath) {
      try {
        const job = await getConvex().query(api.jobs.get, { id: jobId });
        if (job?.projectId) {
          const project = await getConvex().query(api.projects.get, { id: job.projectId });
          if (project) removeWorktree(project.localPath, worktreePath);
        }
      } catch { /* ignore */ }
    }
  }
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
