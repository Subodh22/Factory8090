import { createClaudeSession, type TurnResult } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPushDirect } from "./worktree";

import { broadcast } from "./sse-server";
import { buildRepoMap } from "./repo-map";
import { parseDataUrl, safeFilename } from "./attachments";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import fs from "fs";
import path from "path";
import os from "os";

/** Save base64 attachments (images or any other file) to the worktree, return
 *  message text with their paths prepended so Claude can read them. */
function buildMessageWithAttachments(text: string, attachments: string[], worktreePath: string): string {
  if (!attachments.length) return text;
  const images: string[] = [];
  const files: string[] = [];
  for (const dataUrl of attachments) {
    const parsed = parseDataUrl(dataUrl);
    if (!parsed) continue;
    const ext = parsed.mime.split("/")[1] || "bin";
    const name = parsed.name ? safeFilename(parsed.name) : `attachment.${ext}`;
    const unique = `_factory_${Date.now()}_${Math.random().toString(36).slice(2)}_${name}`;
    const dest = path.join(worktreePath, unique);
    fs.writeFileSync(dest, Buffer.from(parsed.base64, "base64"));
    (parsed.isImage ? images : files).push(dest);
  }
  const refs: string[] = [];
  images.forEach((p, i) => refs.push(`Image ${i + 1}: ${p}`));
  files.forEach((p, i) => refs.push(`File ${i + 1}: ${p}`));
  if (!refs.length) return text;
  return `${refs.join("\n")}\n\n${text}`;
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

// Jobs the user asked to stop mid-flight. Checked after each turn so we tear
// the agent down instead of overwriting the "cancelled" status with completed/failed.
const cancelledJobs = new Set<string>();

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
      existingSession.onChunk((text) => {
        broadcast(jobId, text);
        convex.mutation(api.jobs.appendOutput, { jobId, text }).catch(() => {});
      });

      worktreePath = job.worktreePath!;
      const branch = job.branch!;

      // Deliver every user message that arrived since the previous turn finished
      // (not just the last one), then keep draining any that land mid-turn.
      await conversationLoop({
        jobId,
        session: existingSession,
        turn: null,
        sinceTs: job.completedAt ?? 0,
        worktreePath,
        branch,
        project: project!,
        projectId: job.projectId,
        convex,
      });
      return;
    }

    // -- New session ----------------------------------------------------------
    // Baseline for draining mid-run user messages: anything sent after this
    // point (during worktree setup or the first turn) gets delivered below.
    const turnStartTs = Date.now();
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

    // Save any files attached at job creation to the worktree so Claude can read them
    const promptWithImages = buildMessageWithAttachments(job.prompt, job.images ?? [], worktreePath);
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

    // Drain any user messages that arrived while the first turn was running,
    // then finalize. The active session may have been swapped for a fresh one
    // above (stale-resume retry), so read it back from the map.
    await conversationLoop({
      jobId,
      session: activeSessions.get(jobId)!,
      turn,
      sinceTs: turnStartTs,
      worktreePath,
      branch,
      project: project!,
      projectId: job.projectId,
      convex,
    });

  } catch (err) {
    // A user-requested stop kills the Claude process mid-turn, which surfaces
    // here as a rejection — swallow it rather than marking the job "failed".
    if (reapIfCancelled(jobId, worktreePath, project)) return;
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

/** If the user stopped this job mid-flight, tear everything down without
 *  overwriting the "cancelled" status the UI already set. Returns true if the
 *  job was cancelled and the caller should bail out of further processing. */
function reapIfCancelled(
  jobId: string,
  worktreePath: string | undefined,
  project: { localPath: string } | null,
): boolean {
  if (!cancelledJobs.has(jobId)) return false;
  cancelledJobs.delete(jobId);
  processing.delete(jobId);
  cleanupSession(jobId);
  log(jobId as Id<"jobs">, "Stopped by user.");
  if (worktreePath && project) {
    try { removeWorktree(project.localPath, worktreePath); } catch { /* ignore */ }
  }
  return true;
}

/** User messages newer than `sinceTs`, oldest first. Used to deliver replies a
 *  user queued while a turn was in flight. */
async function pendingUserMessages(
  convex: ConvexHttpClient,
  jobId: Id<"jobs">,
  sinceTs: number,
): Promise<{ text: string; images?: string[]; ts: number }[]> {
  let messages: { role: "assistant" | "user"; text: string; images?: string[]; ts: number }[] = [];
  try {
    messages = await withRetry(() => convex.query(api.jobs.listMessages, { jobId }));
  } catch {
    return [];
  }
  return messages.filter((m) => m.role === "user" && m.ts > sinceTs);
}

interface ConversationLoopArgs {
  jobId: Id<"jobs">;
  session: ReturnType<typeof createClaudeSession>;
  /** Result of a turn already sent (new-session path), or null when the loop
   *  itself must send the first turn (reply path). */
  turn: TurnResult | null;
  /** Only deliver user messages newer than this timestamp. */
  sinceTs: number;
  worktreePath: string;
  branch: string;
  project: { localPath: string; repo: string; defaultBranch: string; githubToken?: string; agentRules?: string };
  projectId: Id<"projects">;
  convex: ConvexHttpClient;
}

/** Deliver any user messages queued while a turn was running — looping so messages
 *  that arrive during a follow-up turn are caught too — then finalize the job.
 *  Owns clearing `processing` for the job. */
async function conversationLoop({
  jobId, session, turn, sinceTs, worktreePath, branch, project, projectId, convex,
}: ConversationLoopArgs): Promise<void> {
  let drainSince = sinceTs;

  while (true) {
    if (reapIfCancelled(jobId, worktreePath, project)) return;

    const pending = await pendingUserMessages(convex, jobId, drainSince);
    if (pending.length === 0) break;

    drainSince = pending[pending.length - 1].ts;
    const combined = pending.map((m) => m.text).filter(Boolean).join("\n\n");
    const images = pending.flatMap((m) => m.images ?? []);
    log(jobId, `User replied: "${combined}"`);
    log(jobId, "-".repeat(40));

    const messageWithAttachments = buildMessageWithAttachments(combined, images, worktreePath);
    turn = await session.sendMessage(messageWithAttachments);
    await convex.mutation(api.jobs.updateUsage, {
      id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd,
    });
    const sessionId = session.getSessionId();
    if (sessionId) projectSessions.set(projectId, { sessionId, inputTokens: turn.inputTokens });
  }

  // No turn ever ran (reply path raced an empty queue) — nothing to finalize.
  if (!turn) { processing.delete(jobId); return; }

  if (reapIfCancelled(jobId, worktreePath, project)) return;
  await handleTurnResult({ jobId, turn, worktreePath, branch, project, convex, keepSession: true });
  processing.delete(jobId);
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

  // Claude made changes — commit directly to default branch, no PR needed
  cleanupSession(jobId);
  try {
    log(jobId, `Pushing changes to ${project.defaultBranch}...`);
    commitAndPushDirect(worktreePath, `feat: ${branch}

Automated by Factory`, project.defaultBranch);
    log(jobId, `Merged to ${project.defaultBranch}.`);

    await withRetry(() =>
      convex.mutation(api.jobs.updateStatus, {
        id: jobId,
        status: "completed",
        touchedPaths: changedFiles,
      })
    );
    log(jobId, "Job completed successfully.");
  } catch (err) {
    const msg = String(err);
    log(jobId, `ERROR during commit/push: ${msg}`);
    await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
  } finally {
    removeWorktree(project.localPath, worktreePath);
    log(jobId, "Worktree cleaned up.");
  }
}
export function cancelJob(jobId: Id<"jobs">) {
  // Flag in-flight jobs so the running turn bails out instead of marking the
  // job completed/failed. Waiting jobs have no turn in flight — just drop them.
  if (processing.has(jobId)) cancelledJobs.add(jobId);
  cleanupSession(jobId);
  processing.delete(jobId);
}

export function getRunningJobs(): string[] {
  return Array.from(processing);
}

/** Every job this worker currently holds — actively processing or with a live
 *  session waiting for a reply. Used to detect cancellations cheaply. */
export function getActiveJobIds(): string[] {
  return Array.from(new Set([...processing, ...activeSessions.keys()]));
}

/** Stop any of the given jobs that this worker is currently running. */
export function reapCancelled(ids: string[]) {
  for (const id of ids) {
    if (processing.has(id) || activeSessions.has(id)) {
      cancelJob(id as Id<"jobs">);
    }
  }
}


