import { createClaudeSession } from "./claude-runner";
import { createWorktree, removeWorktree, getChangedFiles, commitAndPushDirect, ensureRepoCloned, ensureEpicWorktree, commitOnly, mergeIntoBranch } from "./worktree";
import { planEpic } from "./delegator";

import { broadcast, broadcastChat, registerReplyHandler } from "./sse-server";
import { sendJobNotification } from "./notify";
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

// Everything needed to deliver a follow-up reply to a job whose session is
// still alive (status: waiting_for_input, or a finished job we just resumed).
// Chat replies arrive over HTTP (POST /reply/:jobId) and are pushed onto this
// context's queue — nothing about the chat is persisted to Convex.
// When a job is a delegated child task, this carries the epic branch it commits
// into. Absent for plain jobs (they push straight to the default branch).
interface ChildContext {
  parentJobId: Id<"jobs">;
  epicBranch: string;
  epicWorktreePath: string;
}

interface LiveContext {
  worktreePath: string;
  branch: string;
  projectId: Id<"projects">;
  project: { name?: string; localPath: string; repo: string; defaultBranch: string; githubToken?: string; agentRules?: string };
  title?: string;
  busy: boolean;                                  // a turn is currently draining
  queue: { text: string; images: string[] }[];   // replies waiting to be sent
  child?: ChildContext;                           // set when this is a delegated child
}
const liveContext = new Map<string, LiveContext>();

// Serialize the merge-into-epic step per epic so concurrent child tasks don't
// race on the shared integration branch. Single worker process → an in-memory
// promise chain is a correct mutex. Only the git merge is serialized; the
// children's Claude work still runs fully in parallel.
const epicLocks = new Map<string, Promise<unknown>>();
function withEpicLock<T>(epicId: string, fn: () => Promise<T>): Promise<T> {
  const prev = epicLocks.get(epicId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  epicLocks.set(epicId, next.catch(() => {}));
  return next;
}

// Jobs the user asked to stop mid-flight. Checked after each turn so we tear
// the agent down instead of overwriting the "cancelled" status with completed/failed.
const cancelledJobs = new Set<string>();

// Per-project session continuity — carry the session ID across jobs so Claude
// doesn't cold-start on every task. Reset when tokens approach the cap.
const TOKEN_RESUME_CAP = 60_000;
interface ProjectSession { sessionId: string; inputTokens: number }
const projectSessions = new Map<string, ProjectSession>();

function log(jobId: Id<"jobs">, msg: string) {
  // Terminal output is streamed live over SSE only — never persisted to Convex.
  // (Storing every chunk was the dominant source of Convex DB-bandwidth usage.)
  broadcast(jobId, `[factory] ${msg}\n`);
}

/** Was a browser tab open within the last 30s? If so, the UI shows a popup and
 *  we skip the email. On any error, assume offline so the email still goes out. */
async function browserIsOpen(convex: ConvexHttpClient): Promise<boolean> {
  try {
    return await convex.query(api.presence.anyOnline, { since: Date.now() - 30_000 });
  } catch {
    return false;
  }
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
  let jobTitle: string | undefined;
  let project: Awaited<ReturnType<typeof convex.query<typeof api.projects.get>>> | null = null;

  try {
    const job = await withRetry(() => convex.query(api.jobs.get, { id: jobId }));
    if (!job) { processing.delete(jobId); return; }
    jobTitle = job.title;
    project = await withRetry(() => convex.query(api.projects.get, { id: job.projectId }));
    if (!project) { processing.delete(jobId); return; }

    await withRetry(() => convex.mutation(api.jobs.updateStatus, { id: jobId, status: "running" }));

    // Make sure the repo lives on THIS machine. When the UI is hosted remotely
    // (e.g. the Vercel deploy) it can't clone onto the worker's disk, so the
    // project may arrive with no usable localPath — clone it here on first run
    // and persist the resolved path back to Convex.
    const resolvedPath = ensureRepoCloned({
      repo: project.repo,
      localPath: project.localPath,
      githubToken: project.githubToken,
    });
    if (resolvedPath !== project.localPath) {
      log(jobId, `Cloned ${project.repo} to ${resolvedPath}`);
      await withRetry(() =>
        convex.mutation(api.projects.update, { id: job.projectId, localPath: resolvedPath })
      ).catch(() => {});
      project = { ...project, localPath: resolvedPath };
    }

    // -- Epic: plan & split, then hand off to the scheduler -------------------
    if (job.kind === "epic") {
      // Guard against re-planning (e.g. a requeue after the plan already landed).
      if (!job.delegatorPlan) {
        await planEpic(convex, { _id: jobId, title: job.title, prompt: job.prompt, projectId: job.projectId }, project);
      }
      processing.delete(jobId);
      return;
    }

    // -- Child task: base off (and merge into) the epic's integration branch ---
    let baseBranch = project.defaultBranch;
    let childCtx: ChildContext | undefined;
    const isChild = !!job.parentJobId;
    if (job.parentJobId) {
      const parent = await withRetry(() => convex.query(api.jobs.get, { id: job.parentJobId! }));
      const epic = ensureEpicWorktree(project.localPath, job.parentJobId, project.defaultBranch);
      baseBranch = parent?.branch ?? epic.branch;
      childCtx = { parentJobId: job.parentJobId, epicBranch: epic.branch, epicWorktreePath: epic.worktreePath };
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
      const wt = createWorktree(project.localPath, jobId, baseBranch);
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

    // Resume the project's last session if tokens are safely below the cap.
    // Child tasks stay isolated (no shared session) so parallel children don't
    // contend on one session id and don't inherit each other's context.
    const prevSession = isChild ? undefined : projectSessions.get(job.projectId);
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
      broadcast(jobId, text); // SSE only — not persisted
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
        broadcast(jobId, text); // SSE only — not persisted
      });

      const freshSystemContext = `${baseRules}${claudeHint}${repoMap}
---

`;
      turn = await freshSession.sendMessage(freshSystemContext + promptWithImages);
      await convex.mutation(api.jobs.updateUsage, { id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd });

      const freshSessionId = freshSession.getSessionId();
      if (freshSessionId && !isChild) {
        projectSessions.set(job.projectId, { sessionId: freshSessionId, inputTokens: turn.inputTokens });
      }
    } else {
      const finalSessionId = session.getSessionId();
      if (finalSessionId && !isChild) {
        projectSessions.set(job.projectId, { sessionId: finalSessionId, inputTokens: turn.inputTokens });
      }
    }

    if (reapIfCancelled(jobId, worktreePath, project)) return;
    await handleTurnResult({ jobId, title: job.title, turn, worktreePath, branch, projectId: job.projectId, project: project!, convex, keepSession: true, child: childCtx });
    processing.delete(jobId);

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
    await sendJobNotification({ jobId, title: jobTitle, status: "failed", projectName: project?.name, error: msg, browserOnline: await browserIsOpen(getConvex()) });
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
  liveContext.delete(jobId);
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

/** A turn's prose ends with a question → Claude is asking the user something. */
function responseHasQuestion(text: string): boolean {
  const lines = text.trim().split("\n").filter((l) => l.trim());
  if (!lines.length) return false;
  return lines[lines.length - 1].trim().endsWith("?");
}

interface TurnResultArgs {
  jobId: Id<"jobs">;
  title?: string;
  turn: { assistantText: string; resultText: string };
  worktreePath: string;
  branch: string;
  projectId: Id<"projects">;
  project: { name?: string; localPath: string; repo: string; defaultBranch: string; githubToken?: string; agentRules?: string };
  convex: ConvexHttpClient;
  keepSession: boolean;
  child?: ChildContext;
}

async function handleTurnResult({ jobId, title, turn, worktreePath, branch, projectId, project, convex, child }: TurnResultArgs) {
  log(jobId, "-".repeat(40));

  // Surface this turn's prose as a chat bubble (ephemeral — SSE only). It also
  // already streamed into the terminal output; the bubble mirrors it so the
  // chat thread reads as a conversation, just like before.
  const claudeResponse = turn.assistantText.trim() || turn.resultText.trim();
  if (claudeResponse) broadcastChat(jobId, { role: "assistant", text: claudeResponse });

  const changedFiles = getChangedFiles(worktreePath);
  log(jobId, `Changed files: ${changedFiles.length > 0 ? changedFiles.join(", ") : "none"}`);

  if (changedFiles.length === 0) {
    // Claude asked a question and changed nothing — keep the session alive and
    // wait for the user to reply in the chat panel.
    if (responseHasQuestion(claudeResponse)) {
      // Preserve any queue/busy from an in-progress drain so replies that
      // landed mid-turn are still delivered (same array reference).
      const existing = liveContext.get(jobId);
      liveContext.set(jobId, {
        worktreePath, branch, projectId, project, title,
        busy: existing?.busy ?? false,
        queue: existing?.queue ?? [],
        child,
      });
      await withRetry(() =>
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "waiting_for_input" })
      );
      log(jobId, "Waiting for your reply — answer in the chat panel to continue.");
      return; // session stays in activeSessions; process is NOT killed
    }

    // Claude finished without file changes (informational task, explanation, etc.)
    cleanupSession(jobId);
    liveContext.delete(jobId);
    await withRetry(() =>
      convex.mutation(api.jobs.updateStatus, { id: jobId, status: "completed" })
    );
    log(jobId, "Job completed successfully.");
    await sendJobNotification({ jobId, title, status: "completed", projectName: project.name, browserOnline: await browserIsOpen(convex) });
    removeWorktree(project.localPath, worktreePath);
    log(jobId, "Worktree cleaned up.");
    return;
  }

  // Claude made changes.
  cleanupSession(jobId);
  liveContext.delete(jobId);

  // Delegated child task: commit on its own branch and merge into the epic's
  // integration branch (serialized per epic). Nothing is pushed — the epic
  // finalizes the whole thing into one PR once every child lands.
  if (child) {
    try {
      log(jobId, `Committing subtask to ${branch}...`);
      const committed = commitOnly(worktreePath, `feat: ${title ?? branch}

Automated by Factory (delegated)`);
      if (committed) {
        await withEpicLock(child.parentJobId, async () =>
          mergeIntoBranch(child.epicWorktreePath, branch, `merge ${branch} into ${child.epicBranch}`)
        );
        log(jobId, `Merged subtask into ${child.epicBranch}.`);
      } else {
        log(jobId, "No changes to merge.");
      }
      await withRetry(() =>
        convex.mutation(api.jobs.updateStatus, { id: jobId, status: "completed", touchedPaths: changedFiles })
      );
      log(jobId, "Subtask completed.");
      // No per-child notification — the epic notifies once on finalize, and a
      // failed child is surfaced in the DelegatorPanel.
    } catch (err) {
      const msg = String(err);
      log(jobId, `ERROR merging subtask: ${msg}`);
      await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
    } finally {
      removeWorktree(project.localPath, worktreePath);
      log(jobId, "Worktree cleaned up.");
    }
    return;
  }

  // Plain job — commit directly to the default branch, no PR needed.
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
    await sendJobNotification({ jobId, title, status: "completed", projectName: project.name, changedFiles, browserOnline: await browserIsOpen(convex) });
  } catch (err) {
    const msg = String(err);
    log(jobId, `ERROR during commit/push: ${msg}`);
    await convex.mutation(api.jobs.updateStatus, { id: jobId, status: "failed", error: msg });
    await sendJobNotification({ jobId, title, status: "failed", projectName: project.name, error: msg, browserOnline: await browserIsOpen(convex) });
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

// ── Ephemeral chat ─────────────────────────────────────────────────────────
// Replies arrive over HTTP (POST /reply/:jobId, handled by sse-server) and are
// delivered straight to the live Claude session here. Nothing about the chat
// is written to Convex — only the resulting job status is.

/** Entry point invoked by the SSE server when a user posts a reply. Returns
 *  true if the reply was accepted (a live session exists, or a finished job
 *  could be resumed by its saved session id). */
async function deliverReply(jobId: string, text: string, images: string[]): Promise<boolean> {
  const ctx = liveContext.get(jobId);
  if (ctx && activeSessions.has(jobId)) {
    ctx.queue.push({ text, images });
    if (!ctx.busy) void drainReplies(jobId);
    return true;
  }
  // No live session — the job already finished. Try to resume it.
  return continueJob(jobId, text, images);
}

/** Send every queued reply through the live session as follow-up turns, then
 *  finalize via handleTurnResult (which re-enters waiting, completes, or
 *  commits). Re-runs itself if more replies land while it was busy. */
async function drainReplies(jobId: string): Promise<void> {
  const session = activeSessions.get(jobId);
  const ctx = liveContext.get(jobId);
  if (!session || !ctx || ctx.busy) return;

  ctx.busy = true;
  processing.add(jobId); // so a cancel mid-turn is flagged, not marked failed
  const convex = getConvex();

  try {
    await withRetry(() =>
      convex.mutation(api.jobs.updateStatus, { id: jobId as Id<"jobs">, status: "running", worktreePath: ctx.worktreePath, branch: ctx.branch })
    );

    let turn: Awaited<ReturnType<typeof session.sendMessage>> | null = null;
    // Loop so replies that arrive while a turn is in flight are caught too.
    while (ctx.queue.length) {
      if (reapIfCancelled(jobId, ctx.worktreePath, ctx.project)) return;
      const pending = ctx.queue.splice(0, ctx.queue.length);
      const combined = pending.map((p) => p.text).filter(Boolean).join("\n\n");
      const allImages = pending.flatMap((p) => p.images);
      log(jobId as Id<"jobs">, `User replied: "${combined}"`);
      log(jobId as Id<"jobs">, "-".repeat(40));
      const message = buildMessageWithAttachments(combined, allImages, ctx.worktreePath);
      turn = await session.sendMessage(message);
      await convex.mutation(api.jobs.updateUsage, {
        id: jobId as Id<"jobs">, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd,
      });
      const sid = session.getSessionId();
      if (sid) projectSessions.set(ctx.projectId, { sessionId: sid, inputTokens: turn.inputTokens });
    }

    if (!turn) return; // raced an empty queue — nothing sent
    if (reapIfCancelled(jobId, ctx.worktreePath, ctx.project)) return;
    await handleTurnResult({
      jobId: jobId as Id<"jobs">, title: ctx.title, turn,
      worktreePath: ctx.worktreePath, branch: ctx.branch,
      projectId: ctx.projectId, project: ctx.project, convex, keepSession: true,
      child: ctx.child,
    });
  } catch (err) {
    if (reapIfCancelled(jobId, ctx.worktreePath, ctx.project)) return;
    const msg = String(err);
    log(jobId as Id<"jobs">, `FATAL: ${msg}`);
    cleanupSession(jobId);
    await withRetry(() =>
      convex.mutation(api.jobs.updateStatus, { id: jobId as Id<"jobs">, status: "failed", error: msg })
    ).catch(() => {});
  } finally {
    processing.delete(jobId);
    const c = liveContext.get(jobId);
    if (c) {
      c.busy = false;
      if (c.queue.length) void drainReplies(jobId); // late arrivals
    }
  }
}

/** Resume a finished job by its saved session id so the user can keep chatting.
 *  Recreates the worktree (the job/<id> branch still exists), then drains the
 *  reply. Returns false if the job can't be resumed (no session id / no repo). */
async function continueJob(jobId: string, text: string, images: string[]): Promise<boolean> {
  if (activeSessions.has(jobId)) return false;
  const convex = getConvex();

  let job: Awaited<ReturnType<typeof convex.query<typeof api.jobs.get>>>;
  let project: Awaited<ReturnType<typeof convex.query<typeof api.projects.get>>>;
  try {
    job = await convex.query(api.jobs.get, { id: jobId as Id<"jobs"> });
    if (!job || !job.sessionId) return false;
    // Delegated child tasks aren't chat-resumable — their changes only have
    // meaning when merged into the epic branch, which only happens on the
    // live execution path. Redo the child from the epic instead.
    if (job.parentJobId) return false;
    project = await convex.query(api.projects.get, { id: job.projectId });
    if (!project) return false;
  } catch {
    return false;
  }

  let worktreePath: string;
  let branch: string;
  try {
    if (job.worktreePath && fs.existsSync(job.worktreePath)) {
      worktreePath = job.worktreePath;
      branch = job.branch ?? `job/${jobId}`;
    } else {
      const wt = createWorktree(project.localPath, jobId, project.defaultBranch);
      worktreePath = wt.worktreePath;
      branch = wt.branch;
    }
  } catch (err) {
    log(jobId as Id<"jobs">, `Could not reopen worktree to continue: ${String(err)}`);
    return false;
  }

  await withRetry(() =>
    convex.mutation(api.jobs.updateStatus, { id: jobId as Id<"jobs">, status: "running", worktreePath, branch })
  ).catch(() => {});
  log(jobId as Id<"jobs">, `Resuming session ${job.sessionId.slice(0, 8)}… to continue the conversation.`);

  const session = createClaudeSession(worktreePath, job.sessionId);
  activeSessions.set(jobId, session);
  session.onSessionId((id) => {
    convex.mutation(api.jobs.updateStatus, { id: jobId as Id<"jobs">, status: "running", sessionId: id }).catch(() => {});
  });
  session.onChunk((t) => broadcast(jobId, t));

  liveContext.set(jobId, {
    worktreePath, branch, projectId: job.projectId, project,
    title: job.title, busy: false, queue: [{ text, images }],
  });
  void drainReplies(jobId);
  return true;
}

// Wire the HTTP reply endpoint to the delivery logic above.
registerReplyHandler(deliverReply);


