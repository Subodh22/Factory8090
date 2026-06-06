import { createClaudeSession } from "./claude-runner";
import { createWorktree, removeWorktree, ensureEpicWorktree } from "./worktree";
import { buildRepoMap } from "./repo-map";
import { broadcast } from "./sse-server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { ConvexHttpClient } from "convex/browser";
import fs from "fs";
import path from "path";

export interface Subtask {
  localId: string;
  title: string;
  prompt: string;
  touchedPaths: string[];
  dependsOn: string[];
}

interface EpicJob {
  _id: Id<"jobs">;
  title: string;
  prompt: string;
  projectId: Id<"projects">;
}
interface PlanProject {
  localPath: string;
  defaultBranch: string;
  repo: string;
  githubToken?: string;
  agentRules?: string;
}

function log(jobId: Id<"jobs">, msg: string) {
  broadcast(jobId, `[factory] ${msg}\n`);
}

const PLAN_FILE = path.join(".factory", "plan.json");

function plannerInstructions(): string {
  return `You are the FACTORY DELEGATOR — a planning agent. You will NOT write any
application code. Your only job is to decompose the task below into a dependency
graph of independent subtasks that other fresh agents will each implement in
their own git worktree.

Rules for a good plan:
- Break the work into the SMALLEST set of coherent subtasks that each produce a
  self-contained, independently-committable change. If the task is genuinely
  small, a single subtask is fine.
- Each subtask is handed to a FRESH agent with no memory of this plan, so its
  "prompt" must be fully self-contained: state exactly what to build and where.
- "touchedPaths" lists every file or directory the subtask will create or modify.
- "dependsOn" lists the localIds of subtasks that must finish FIRST (e.g. a UI
  task that calls an API the other subtask creates).
- Subtasks that do NOT depend on each other run in PARALLEL, so their
  touchedPaths MUST be disjoint — never let two parallel subtasks edit the same
  file. If two pieces of work must touch the same file, either merge them into
  one subtask or make one depend on the other.

Output: create the directory \`.factory\` and WRITE your plan as JSON to
\`.factory/plan.json\` (and nothing else — do not modify any other files). The
file must match exactly this shape:

{
  "subtasks": [
    {
      "localId": "t1",
      "title": "Short imperative title",
      "prompt": "Full self-contained instructions for the implementing agent.",
      "touchedPaths": ["path/to/file.ts"],
      "dependsOn": []
    }
  ]
}

After writing the file, reply with a one-line confirmation. Do not paste the JSON
into your reply.`;
}

/** Throws if the plan is empty, has duplicate ids, references unknown deps, or
 *  contains a dependency cycle. */
function validatePlan(subtasks: Subtask[]): void {
  if (!Array.isArray(subtasks) || subtasks.length === 0) {
    throw new Error("plan has no subtasks");
  }
  const ids = new Set<string>();
  for (const s of subtasks) {
    if (!s.localId || !s.title || !s.prompt) throw new Error("subtask missing localId/title/prompt");
    if (ids.has(s.localId)) throw new Error(`duplicate subtask id: ${s.localId}`);
    ids.add(s.localId);
  }
  for (const s of subtasks) {
    for (const d of s.dependsOn ?? []) {
      if (!ids.has(d)) throw new Error(`subtask ${s.localId} depends on unknown id ${d}`);
    }
  }
  // Cycle detection via DFS colouring.
  const adj = new Map(subtasks.map((s) => [s.localId, s.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (n: string) => {
    const st = state.get(n) ?? 0;
    if (st === 1) throw new Error("plan contains a dependency cycle");
    if (st === 2) return;
    state.set(n, 1);
    for (const d of adj.get(n) ?? []) visit(d);
    state.set(n, 2);
  };
  for (const s of subtasks) visit(s.localId);
}

/** Read the plan the agent wrote to .factory/plan.json; fall back to the first
 *  fenced/bare JSON object in the agent's prose. */
function extractPlan(worktreePath: string, assistantText: string): Subtask[] {
  const filePath = path.join(worktreePath, PLAN_FILE);
  let raw: string | null = null;
  try {
    if (fs.existsSync(filePath)) raw = fs.readFileSync(filePath, "utf8");
  } catch { /* fall through to prose parsing */ }

  if (!raw) {
    const fenced = assistantText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : assistantText.slice(assistantText.indexOf("{"));
    raw = candidate;
  }
  if (!raw || !raw.trim()) throw new Error("planner produced no plan");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Last resort: grab the outermost {...} span.
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error("planner output was not valid JSON");
    parsed = JSON.parse(raw.slice(start, end + 1));
  }

  const subtasks = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasks)) throw new Error("plan JSON missing a subtasks array");
  return subtasks.map((s) => {
    const o = s as Record<string, unknown>;
    return {
      localId: String(o.localId ?? ""),
      title: String(o.title ?? ""),
      prompt: String(o.prompt ?? ""),
      touchedPaths: Array.isArray(o.touchedPaths) ? o.touchedPaths.map(String) : [],
      dependsOn: Array.isArray(o.dependsOn) ? o.dependsOn.map(String) : [],
    };
  });
}

/**
 * Plan an epic: run one read-only Claude turn to decompose it, then materialize
 * the resulting DAG as child jobs and create the epic integration branch. On
 * success the epic ends in status "delegating" and the worker's scheduler takes
 * over. Throws on any failure so the caller marks the epic failed.
 */
export async function planEpic(convex: ConvexHttpClient, job: EpicJob, project: PlanProject): Promise<void> {
  const jobId = job._id;
  log(jobId, `Planning epic — "${job.title}"`);

  // Scratch worktree for the planner to read the repo. Removed afterwards; the
  // epic's real integration branch is created separately below.
  const { worktreePath } = createWorktree(project.localPath, `${jobId}-plan`, project.defaultBranch);

  try {
    const session = createClaudeSession(worktreePath); // fresh — no project-session resume
    session.onChunk((text) => broadcast(jobId, text));

    const baseRules = project.agentRules ? `${project.agentRules}\n\n` : "";
    const repoMap = buildRepoMap(worktreePath);
    const message = `${baseRules}${repoMap}\n---\n\n${plannerInstructions()}\n\n---\n\nTASK TO DECOMPOSE:\n\n${job.prompt}`;

    log(jobId, "Launching planner...");
    log(jobId, "-".repeat(40));
    const turn = await session.sendMessage(message);
    await convex
      .mutation(api.jobs.updateUsage, { id: jobId, inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, costUsd: turn.costUsd })
      .catch(() => {});

    const subtasks = extractPlan(worktreePath, turn.assistantText);
    validatePlan(subtasks);
    log(jobId, `Plan: ${subtasks.length} subtask(s).`);

    // Create the integration branch + its worktree before children are queued so
    // the first child can branch off it immediately.
    const { branch } = ensureEpicWorktree(project.localPath, jobId, project.defaultBranch);

    await convex.mutation(api.jobs.createChildren, {
      epicId: jobId,
      subtasks: subtasks.map((s) => ({
        localId: s.localId,
        title: s.title,
        prompt: s.prompt,
        touchedPaths: s.touchedPaths,
        dependsOn: s.dependsOn,
      })),
    });

    await convex.mutation(api.jobs.setDelegatorPlan, {
      id: jobId,
      delegatorPlan: JSON.stringify({ subtasks }),
      branch,
    });

    log(jobId, `Delegating ${subtasks.length} subtask(s) on ${branch}.`);
  } finally {
    removeWorktree(project.localPath, worktreePath);
  }
}
