import type { ConvexClient } from "convex/browser";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { ensureEpicWorktree, pushBranch, pushBranchToDefault, removeWorktree, deleteBranch } from "./worktree";
import { createPR } from "./github";
import { broadcast } from "./sse-server";
import { sendJobNotification } from "./notify";

// Minimal shape of the job rows we read from listDelegationState.
interface JobRow {
  _id: Id<"jobs">;
  title: string;
  status: string;
  blockedBy?: Id<"jobs">[];
  touchedPaths?: string[];
  projectId: Id<"projects">;
  delegatorPlan?: string;
  branch?: string;
}
interface EpicState {
  epic: JobRow;
  children: JobRow[];
}

// Idempotency guards across subscription re-fires (single worker process).
const promoted = new Set<string>();
const finalizing = new Set<string>();

function log(jobId: Id<"jobs">, msg: string) {
  broadcast(jobId, `[factory] ${msg}\n`);
}

/** True if two touchedPath sets refer to any of the same files/dirs. */
function pathsOverlap(a: string[], b: string[]): boolean {
  for (const x of a) {
    for (const y of b) {
      if (x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`)) return true;
    }
  }
  return false;
}

/**
 * Re-evaluate every delegating epic. Called whenever Convex pushes a change to
 * listDelegationState (any epic or child row changed). Promotes child tasks that
 * are now unblocked, and finalizes epics whose children have all completed.
 */
export function handleDelegationUpdate(convex: ConvexClient, epics: EpicState[]) {
  for (const state of epics) {
    try {
      evaluateEpic(convex, state);
    } catch (err) {
      console.error(`[delegator] evaluate error for ${state.epic._id}: ${err}`);
    }
  }
}

function evaluateEpic(convex: ConvexClient, { epic, children }: EpicState) {
  if (children.length === 0) return;

  const completed = new Set(children.filter((c) => c.status === "completed").map((c) => c._id));
  // Siblings currently holding the integration branch's attention; new promotions
  // must not edit the same paths as these.
  const inFlight: JobRow[] = children.filter((c) => c.status === "running" || c.status === "queued");

  for (const c of children) {
    if (c.status !== "pending" || promoted.has(c._id)) continue;
    const ready = (c.blockedBy ?? []).every((b) => completed.has(b));
    if (!ready) continue;
    const conflict = inFlight.some((s) => pathsOverlap(s.touchedPaths ?? [], c.touchedPaths ?? []));
    if (conflict) continue;

    promoted.add(c._id);
    inFlight.push(c); // so an overlapping sibling isn't also promoted this tick
    log(epic._id, `Dispatching subtask "${c.title}".`);
    convex
      .mutation(api.jobs.updateStatus, { id: c._id, status: "queued" })
      .catch((err: unknown) => {
        promoted.delete(c._id); // let a later tick retry
        console.error(`[delegator] promote failed for ${c._id}: ${err}`);
      });
  }

  const anyFailed = children.some((c) => c.status === "failed");
  const allDone = children.every((c) => c.status === "completed");
  if (allDone && !finalizing.has(epic._id)) {
    finalizing.add(epic._id);
    void finalizeEpic(convex, epic).catch((err) => {
      finalizing.delete(epic._id);
      console.error(`[delegator] finalize error for ${epic._id}: ${err}`);
    });
  } else if (anyFailed) {
    // Epic stays "delegating" — independent siblings keep going, but it can't
    // finalize until the failed child is redone (or the epic is cancelled). The
    // DelegatorPanel surfaces the failed child with a Redo control.
    log(epic._id, "A subtask failed — epic paused. Redo it to continue.");
  }
}

async function finalizeEpic(convex: ConvexClient, epic: JobRow) {
  const project = await convex.query(api.projects.get, { id: epic.projectId });
  if (!project) throw new Error("project not found");

  const { worktreePath, branch } = ensureEpicWorktree(project.localPath, epic._id, project.defaultBranch);

  // Build a PR/commit body from the plan.
  let bodyLines = "Delegated epic completed by Factory.";
  try {
    const plan = epic.delegatorPlan ? JSON.parse(epic.delegatorPlan) : null;
    if (plan?.subtasks?.length) {
      bodyLines += "\n\nSubtasks:\n" + plan.subtasks
        .map((s: { title: string; touchedPaths?: string[] }) => `- ${s.title}${s.touchedPaths?.length ? ` (${s.touchedPaths.join(", ")})` : ""}`)
        .join("\n");
    }
  } catch { /* plan unparseable — use the default body */ }

  try {
    if (project.githubToken) {
      log(epic._id, `Pushing ${branch} and opening a PR...`);
      pushBranch(worktreePath, branch);
      const [owner, repo] = project.repo.split("/");
      const pr = await createPR(project.githubToken, owner, repo, branch, project.defaultBranch, epic.title, bodyLines);
      await convex.mutation(api.jobs.updateStatus, {
        id: epic._id,
        status: "completed",
        prUrl: pr.url,
        prNumber: pr.number,
      });
      log(epic._id, `Opened PR #${pr.number}: ${pr.url}`);
    } else {
      // No token to open a PR — fall back to pushing straight to default,
      // matching how plain jobs behave without a token.
      log(epic._id, `No GitHub token — pushing ${branch} to ${project.defaultBranch}...`);
      pushBranchToDefault(worktreePath, project.defaultBranch);
      await convex.mutation(api.jobs.updateStatus, { id: epic._id, status: "completed" });
      log(epic._id, `Merged epic to ${project.defaultBranch}.`);
    }

    await sendJobNotification({
      jobId: epic._id,
      title: epic.title,
      status: "completed",
      projectName: project.name,
      browserOnline: false,
    }).catch(() => {});
  } catch (err) {
    const msg = String(err);
    log(epic._id, `ERROR finalizing epic: ${msg}`);
    await convex.mutation(api.jobs.updateStatus, { id: epic._id, status: "failed", error: msg }).catch(() => {});
    throw err;
  } finally {
    // Tidy the integration worktree; the branch lives on (remote PR / merged).
    try {
      removeWorktree(project.localPath, worktreePath);
      deleteBranch(project.localPath, branch);
    } catch { /* best-effort */ }
    finalizing.delete(epic._id);
    promoted.delete(epic._id);
  }
}
