import { createClaudeSession } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPush } from "./worktree";
import { createPR, mergePR } from "./github";
import { broadcast } from "./sse-server";
import { buildRepoMap } from "./repo-map";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import fs from "fs";
import path from "path";
import os from "os";

/** Save base64 images to temp files, return message text with image paths prepended. */
function buildMessageWithImages(text: string, images: string[], worktreePath: string): string {
  if (!images.length) return text;
  const paths: string[] = [];
  for (const dataUrl of images) {
    const m = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!m) continue;
    const [, ext, b64] = m;
    const dest = path.join(worktreePath, `_factory_img_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(dest, Buffer.from(b64, "base64"));
    paths.push(dest);
  }
  if (!paths.length) return text;
  const refs = paths.map((p, i) => `Image ${i + 1}: ${p}`).join("\n");
  return `${refs}\n\n${text}`;
}

/** Read CLAUDE.md from the worktree root, or null if it doesn't exist. */
function readClaudeMd(dir: string): string | null {
  const p = path.join(dir, "CLAUDE.md");
  try {
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  } catch {
    return null;
  }
}


let _convex: ConvexHttpClient | null = null;
function getConvex(): ConvexHttpClient {
  if (!_convex) _convex = new ConvexHttpClient(process.env.NEXT_PUBLIC_CONVEX_URL!);
  return _convex;
}

// Active Claude sessions — keyed by jobId. Session process stays alive between user turns.
const activeSessions = new Map<string, ReturnType<typeof createClaudeSession>>();
const processing = new Set<string>();

// Per-project session continuity — carry the session ID across jobs so Claude
// doesn't cold-start on every task. Reset when tokens approach the cap.
const TOKEN_RESUME_CAP = 60_000;
interface ProjectSession { sessionId: string; inputTokens: number }
const projectSessions = new Map<string, ProjectSession>();

function log(jobId: Id<"jobs">, msg: string) {
  const line = `[factory] ${msg}\n`;
  broadcast(jobId, line);
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

    // -- Existing session: user replied to a waiting job ---------------------
    const existingSession = activeSessions.get(jobId);
    if (existingSession) {
      // Get the latest user message to send
      let messages: { role: "assistant" | "user"; text: string; images?: string[]; _id: string }[] = [];
      try {
        messages = await withRetry(() => convex.query(api.jobs.listMessages, { jobId }));
      } catch { /* continue with empty */ }

      const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
      if (!lastUserMsg) { processing.delete(jobId); return; }

      log(jobId, `User replied: "${lastUserMsg.text}"`);
      log(jobId, "-".repeat(40));

      existingSession.onChunk((text) => {
        broadcast(jobId, text);
        convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
      });

      worktreePath = job.worktreePath!;
      const branch = job.branch!;

      // Save any attached images to the worktree so Claude can read them
      const messageWithImages = buildMessageWithImages(lastUserMsg.text, lastUserMsg.images ?? [], worktreePath);
      const turn = await existingSession.sendMessage(messageWithImages);
      await convex.mutation(api.jobs.updateUsage, { id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd });

      const replySessionId = existingSession.getSessionId();
      if (replySessionId) {
        projectSessions.set(job.projectId, { sessionId: replySessionId, inputTokens: turn.inputTokens });
      }

      await handleTurnResult({ jobId, turn, worktreePath, branch, project: project!, convex, keepSession: true });
      processing.delete(jobId);
      return;
    }

    // -- New session ----------------------------------------------------------
    log(jobId, `Job started â€" "${job.title}"`);

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

    log(jobId, "Launching Claude Code CLI...");
    log(jobId, "-".repeat(40));

    // Resume the project's last session if tokens are safely below the cap
    const prevSession = projectSessions.get(job.projectId);
    const resumeId = prevSession && prevSession.inputTokens < TOKEN_RESUME_CAP
      ? prevSession.sessionId
      : undefined;
    if (resumeId) log(jobId, `Resuming project session ${resumeId.slice(0, 8)}...`);

    // Create persistent session - process stays alive for the whole job
    const session = createClaudeSession(worktreePath, resumeId);
    activeSessions.set(jobId, session);

    session.onSessionId((id) => {
      convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", sessionId: id }).catch(() => {});
    });

    session.onChunk((text) => {
      broadcast(jobId, text);
      convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
    });

    const baseRules = project.agentRules ? `${project.agentRules}\n\n` : "";
    const hasClaude = readClaudeMd(worktreePath) !== null;
    const claudeHint = hasClaude
      ? "Read CLAUDE.md before starting.\n\n"
      : "No CLAUDE.md found - create one first, then do the task.\n\n";
    const repoMap = buildRepoMap(worktreePath);
    const resumeNote = resumeId
      ? `You are continuing work on this project in a new worktree at: ${worktreePath}\n\n`
      : "";

    const systemContext = `${baseRules}${claudeHint}${resumeNote}${repoMap}\n---\n\n`;

    // Save any images attached at job creation to the worktree so Claude can read them
    const promptWithImages = buildMessageWithImages(job.prompt, job.images ?? [], worktreePath);
    let turn = await session.sendMessage(systemContext + promptWithImages);
    await convex.mutation(api.jobs.updateUsage, { id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd });

    // If resume was stale (Claude: "No conversation found"), retry fresh immediately
    const claudeReturnedNothing = !turn.assistantText.trim() && !turn.resultText.trim();
    if (claudeReturnedNothing && resumeId) {
      projectSessions.delete(job.projectId);
      log(jobId, "Stale session, retrying fresh...");
      cleanupSession(jobId);

      const freshSession = createClaudeSession(worktreePath);
      activeSessions.set(jobId, freshSession);
      freshSession.onSessionId((id) => {
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running", sessionId: id }).catch(() => {});
      });
      freshSession.onChunk((text) => {
        broadcast(jobId, text);
        convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
      });

      const freshSystemContext = `${baseRules}${claudeHint}${repoMap}
---

`;
      turn = await freshSession.sendMessage(freshSystemContext + promptWithImages);
      await convex.mutation(api.jobs.updateUsage, { id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd });

      const freshSessionId = freshSession.getSessionId();
      if (freshSessionId) {
        projectSessions.set(job.projectId, { sessionId: freshSessionId, inputTokens: turn.inputTokens });
      }
    } else {
      const finalSessionId = session.getSessionId();
      if (finalSessionId) {
        projectSessions.set(job.projectId, { sessionId: finalSessionId, inputTokens: turn.inputTokens });
      }
    }

    await handleTurnResult({ jobId, turn, worktreePath, branch, project: project!, convex, keepSession: true });
    processing.delete(jobId);

  } catch (err) {
    processing.delete(jobId);
    cleanupSession(jobId);
    const msg = String(err);
    console.error(`[startJob] unhandled error for ${jobId}: ${msg}`);
    log(jobId as Id<"jobs">, `FATAL: ${msg}`);
    // Retry the status update — a transient Convex error here leaves the job stuck as "running"
    await withRetry(() =>
      getConvex().mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg })
    ).catch((e) => console.error(`[startJob] could not mark job failed: ${e}`));
    if (worktreePath && project) {
      try { removeWorktree(project.localPath, worktreePath); } catch { /* ignore */ }
    }
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

function responseHasQuestion(text: string): boolean {
  const lines = text.trim().split(String.fromCharCode(10)).filter((l) => l.trim());
  if (!lines.length) return false;
  return lines[lines.length - 1].trim().endsWith("?");
}

async function handleTurnResult({ jobId, turn, worktreePath, branch, project, convex }: TurnResultArgs) {
  log(jobId, "-".repeat(40));

  const changedFiles = getChangedFiles(worktreePath);
  log(jobId, `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`);

  const claudeResponse = turn.assistantText.trim() || turn.resultText.trim();

  if (changedFiles.length === 0) {
    if (responseHasQuestion(claudeResponse)) {
      // Claude is asking a question — save message, wait for reply
      log(jobId, "Waiting for your reply...");
      if (claudeResponse) {
        await convex.mutation(api.jobs.addMessage, { jobId, role: "assistant", text: claudeResponse });
      }
      await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "waiting_for_input" });
      log(jobId, "Reply in the chat panel to continue.");
      // Session stays alive in activeSessions — process is NOT killed
      return;
    }

    // Claude finished without file changes (informational task, explanation, etc.)
    cleanupSession(jobId);
    if (claudeResponse) {
      await convex.mutation(api.jobs.addMessage, { jobId, role: "assistant", text: claudeResponse });
    }
    await withRetry(() =>
      convex.mutation(api.jobs.updateStatus, { id: jobId, status: "completed" })
    );
    log(jobId, "Job completed successfully.");
    removeWorktree(project.localPath, worktreePath);
    log(jobId, "Worktree cleaned up.");
    return;
  }

  // Claude made changes â€" commit, PR, complete
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

          // Wait for GitHub to compute mergeability before attempting merge
          await new Promise((r) => setTimeout(r, 3000));
          try {
            await mergePR(project.githubToken, owner, repo, pr.number, job?.title ?? branch);
            log(jobId, "PR merged automatically.");
          } catch (mergeErr) {
            // Retry once — GitHub sometimes needs more time
            try {
              await new Promise((r) => setTimeout(r, 5000));
              await mergePR(project.githubToken, owner, repo, pr.number, job?.title ?? branch);
              log(jobId, "PR merged automatically (retry).");
            } catch (retryErr) {
              log(jobId, `Auto-merge failed — check branch protection rules: ${retryErr}`);
            }
          }
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
    log(jobId, "Job completed successfully.");
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


