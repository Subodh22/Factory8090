import { createClaudeSession } from "./claude-runner";
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

// Active Claude sessions â€” keyed by jobId. Session process stays alive between user turns.
const activeSessions = new Map<string, ReturnType<typeof createClaudeSession>>();
const processing = new Set<string>();

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
  if (processing.has(jobId)) return;
  processing.add(jobId);

  const convex = getConvex();
  let worktreePath: string | undefined;
  let project: Awaited<ReturnType<typeof convex.query<typeof api.projects.get>>> | null = null;

  try {
    const job = await withRetry(() => convex.query(api.jobs.get, { id: jobId }));
    if (!job) { processing.delete(jobId); return; }
    project = await withRetry(() => convex.query(api.projects.get, { id: job.projectId }));
    if (!project) { processing.delete(jobId); return; }

    await withRetry(() => convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running" }));

    // â”€â”€ Existing session: user replied to a waiting job â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const existingSession = activeSessions.get(jobId);
    if (existingSession) {
      // Get the latest user message to send
      let messages: { role: "assistant" | "user"; text: string; _id: string }[] = [];
      try {
        messages = await withRetry(() => convex.query(api.jobs.listMessages, { jobId }));
      } catch { /* continue with empty */ }

      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) { processing.delete(jobId); return; }

      log(jobId, `User replied: "${lastUserMsg.text}"`);
      log(jobId, "â”€".repeat(40));

      existingSession.onChunk((text) => {
        convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
      });

      worktreePath = job.worktreePath!;
      const branch = job.branch!;

      const turn = await existingSession.sendMessage(lastUserMsg.text);
      await handleTurnResult({ jobId, turn, worktreePath, branch, project: project!, convex, keepSession: true });
      processing.delete(jobId);
      return;
    }

    // â”€â”€ New session â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    log(jobId, `Job started â€” "${job.title}"`);

    // Worktree
    const existingWorktree = job.worktreePath && fs.existsSync(job.worktreePath);
    let branch: string;

    if (existingWorktree) {
      worktreePath = job.worktreePath!;
      branch = job.branch!;
      log(jobId, `Reusing worktree: ${worktreePath}`);
    } else {
      log(jobId, `Repo: ${project.localPath}`);
      log(jobId, "Creating git worktreeâ€¦");
      const wt = createWorktree(project.localPath, jobId, project.defaultBranch);
      worktreePath = wt.worktreePath;
      branch = wt.branch;
      log(jobId, `Worktree ready: ${worktreePath}`);
      log(jobId, `Branch: ${branch}`);
      await withRetry(() =>
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", worktreePath, branch })
      );
    }

    log(jobId, "Launching Claude Code CLIâ€¦");
    log(jobId, "â”€".repeat(40));

    // Create persistent session â€” process stays alive for the whole job
    const session = createClaudeSession(worktreePath);
    activeSessions.set(jobId, session);

    session.onSessionId((id) => {
      convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", sessionId: id }).catch(() => {});
    });

    session.onChunk((text) => {
      convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
    });

    // Prepend agent rules to the first message so Claude has full project context
    const systemContext = project.agentRules
      ? `Project context:\n${project.agentRules}\n\nYou are a coding assistant. Implement tasks directly by reading and modifying files in the repo.\n\n---\n\n`
      : `You are a coding assistant. Implement tasks directly by reading and modifying files in the repo.\n\n---\n\n`;

    const turn = await session.sendMessage(systemContext + job.prompt);
    await handleTurnResult({ jobId, turn, worktreePath, branch, project: project!, convex, keepSession: true });
    processing.delete(jobId);

  } catch (err) {
    processing.delete(jobId);
    const msg = String(err);
    console.error(`[startJob] unhandled error for ${jobId}: ${msg}`);
    try {
      log(jobId as Id<"jobs">, `FATAL: ${msg}`);
      await getConvex().mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
    } catch { /* ignore */ }
    if (worktreePath && project) {
      try { removeWorktree(project.localPath, worktreePath); } catch { /* ignore */ }
    }
    cleanupSession(jobId);
  }
}

function cleanupSession(jobId: string) {
  const session = activeSessions.get(jobId);
  if (session) {
    session.cancel();
    activeSessions.delete(jobId);
  }
}

interface TurnResultArgs {
  jobId: Id<"jobs">;
  turn: { assistantText: string; resultText: string };
  worktreePath: string;
  branch: string;
  project: { localPath: string; repo: string; defaultBranch: string; githubToken?: string; agentRules?: string };
  convex: ConvexHttpClient;
  keepSession: boolean;
}

async function handleTurnResult({ jobId, turn, worktreePath, branch, project, convex }: TurnResultArgs) {
  log(jobId, "â”€".repeat(40));

  const changedFiles = getChangedFiles(worktreePath);
  log(jobId, `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`);

  const claudeResponse = turn.assistantText.trim() || turn.resultText.trim();

  if (changedFiles.length === 0) {
    // Claude is asking a question or needs more info â€” save message, wait for reply
    log(jobId, "â³ Waiting for your replyâ€¦");
    if (claudeResponse) {
      await convex.mutation(api.jobs.addMessage, { jobId, role: "assistant", text: claudeResponse });
    }
    await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "waiting_for_input" });
    log(jobId, "Reply in the chat panel to continue.");
    // Session stays alive in activeSessions â€” process is NOT killed
    return;
  }

  // Claude made changes â€” commit, PR, complete
  cleanupSession(jobId);
  try {
    commitAndPush(worktreePath, `feat: ${branch}\n\nAutomated by Factory`);
    log(jobId, "Committed and pushed.");

    const [owner, repo] = project.repo.split("/");
    let prUrl: string | undefined;
    let prNumber: number | undefined;

    if (project.githubToken) {
      log(jobId, "Creating pull requestâ€¦");
      try {
        const job = await convex.query(api.jobs.get, { id: jobId });
        const pr = await createPR(project.githubToken, owner, repo, {
          title: job?.title ?? branch,
          body: `## Changes\n${job?.prompt ?? ""}\n\nAutomated by Factory`,
          head: branch,
          base: project.defaultBranch,
          issueNumber: job?.githubIssueNumber,
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
      })
    );
    log(jobId, "âœ“ Job completed successfully.");
  } catch (err) {
    const msg = String(err);
    log(jobId, `ERROR during commit/push/PR: ${msg}`);
    await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
  } finally {
    removeWorktree(project.localPath, worktreePath);
    log(jobId, "Worktree cleaned up.");
  }
}

export function cancelJob(jobId: Id<"jobs">) {
  cleanupSession(jobId);
  processing.delete(jobId);
}

export function getRunningJobs(): string[] {
  return Array.from(processing);
}

