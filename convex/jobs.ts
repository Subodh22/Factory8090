import { mutation, query } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const list = query({
  args: { projectId: v.optional(v.id("projects")) },
  handler: async (ctx, { projectId }) => {
    if (projectId) {
      return ctx.db
        .query("jobs")
        .withIndex("by_project", (q) => q.eq("projectId", projectId))
        .order("desc")
        .collect();
    }
    return ctx.db.query("jobs").order("desc").collect();
  },
});

export const get = query({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const listByStatus = query({
  args: { status: v.string() },
  handler: async (ctx, { status }) =>
    ctx.db
      .query("jobs")
      .withIndex("by_status", (q) =>
        q.eq("status", status as "pending" | "queued" | "running" | "completed" | "failed" | "cancelled" | "waiting_for_input" | "delegating")
      )
      .collect(),
});

export const create = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    prompt: v.string(),
    images: v.array(v.string()),
    priority: v.optional(v.number()),
    githubIssueNumber: v.optional(v.number()),
    // "epic" routes the job to the Delegator (plan → split into child tasks).
    kind: v.optional(v.union(v.literal("epic"), v.literal("task"))),
    model: v.optional(v.string()),
    effort: v.optional(v.union(v.literal("low"), v.literal("medium"), v.literal("high"), v.literal("max"))),
  },
  handler: async (ctx, args) => {
    return ctx.db.insert("jobs", {
      projectId: args.projectId,
      title: args.title,
      prompt: args.prompt,
      images: args.images,
      status: "pending",
      priority: args.priority ?? 50,
      touchedPaths: [],
      blockedBy: [],
      createdAt: Date.now(),
      githubIssueNumber: args.githubIssueNumber,
      kind: args.kind,
      model: args.model,
      effort: args.effort,
    });
  },
});

// Re-run a finished job: clone it into a fresh queued job, optionally adding
// extra prompt text and/or images. Leaves the original job (and its history) intact.
export const redo = mutation({
  args: {
    sourceJobId: v.id("jobs"),
    extraPrompt: v.optional(v.string()),
    extraImages: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { sourceJobId, extraPrompt, extraImages }) => {
    const src = await ctx.db.get(sourceJobId);
    if (!src) throw new Error("source job not found");

    const extra = extraPrompt?.trim();
    const prompt = extra ? `${src.prompt}\n\n${extra}` : src.prompt;
    const images = [...src.images, ...(extraImages ?? [])];
    const title = src.title.startsWith("Redo: ") ? src.title : `Redo: ${src.title}`;

    return ctx.db.insert("jobs", {
      projectId: src.projectId,
      title,
      prompt,
      images,
      status: "queued",
      priority: src.priority ?? 50,
      touchedPaths: [],
      blockedBy: [],
      createdAt: Date.now(),
      githubIssueNumber: src.githubIssueNumber,
      model: src.model,
      effort: src.effort,
    });
  },
});

// Append extra instructions (and optional images) to a job's prompt while it's
// still in the backlog. Only allowed before the job starts running.
export const appendPrompt = mutation({
  args: {
    id: v.id("jobs"),
    text: v.string(),
    images: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { id, text, images }) => {
    const job = await ctx.db.get(id);
    if (!job) throw new Error("job not found");
    if (job.status !== "pending" && job.status !== "queued") {
      throw new Error("can only add to the prompt before a job starts running");
    }
    const trimmed = text.trim();
    const prompt = trimmed ? `${job.prompt}\n\n${trimmed}` : job.prompt;
    const newImages = images?.length ? [...job.images, ...images] : job.images;
    await ctx.db.patch(id, { prompt, images: newImages });
  },
});

export const updateStatus = mutation({
  args: {
    id: v.id("jobs"),
    status: v.union(
      v.literal("pending"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("waiting_for_input"),
      v.literal("delegating")
    ),
    worktreePath: v.optional(v.string()),
    branch: v.optional(v.string()),
    error: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    touchedPaths: v.optional(v.array(v.string())),
    delegatorPlan: v.optional(v.string()),
    sessionId: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, ...fields }) => {
    const updates: Record<string, unknown> = { status };
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined) updates[k] = v;
    }
    if (status === "running") updates.startedAt = Date.now();
    if (status === "completed" || status === "failed" || status === "waiting_for_input") updates.completedAt = Date.now();
    await ctx.db.patch(id, updates);
  },
});

export const appendOutput = mutation({
  args: { jobId: v.id("jobs"), text: v.string() },
  handler: async (ctx, { jobId, text }) => {
    // Append-only: each chunk is one row. The UI reconstructs the log from these
    // via getOutput. We deliberately do NOT also accumulate a `job.output` string
    // — patching a growing field on every chunk re-reads and re-writes the whole
    // log each time (O(N²) bandwidth) and nothing reads that field.
    await ctx.db.insert("outputChunks", { jobId, text, ts: Date.now() });
  },
});

export const getOutput = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) =>
    ctx.db
      .query("outputChunks")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .order("asc")
      .collect(),
});

export const updateUsage = mutation({
  args: {
    id: v.id("jobs"),
    inputTokens: v.number(),
    outputTokens: v.number(),
    costUsd: v.number(),
  },
  handler: async (ctx, { id, inputTokens, outputTokens, costUsd }) => {
    const job = await ctx.db.get(id);
    if (!job) return;
    await ctx.db.patch(id, {
      inputTokens: (job.inputTokens ?? 0) + inputTokens,
      outputTokens: (job.outputTokens ?? 0) + outputTokens,
      costUsd: (job.costUsd ?? 0) + costUsd,
    });
  },
});

export const getTodayStats = query({
  args: {},
  handler: async (ctx) => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const jobs = await ctx.db
      .query("jobs")
      .filter((q) => q.gte(q.field("createdAt"), dayStart.getTime()))
      .collect();
    return jobs.reduce(
      (acc, j) => ({
        inputTokens: acc.inputTokens + (j.inputTokens ?? 0),
        outputTokens: acc.outputTokens + (j.outputTokens ?? 0),
        costUsd: acc.costUsd + (j.costUsd ?? 0),
        jobCount: acc.jobCount + 1,
      }),
      { inputTokens: 0, outputTokens: 0, costUsd: 0, jobCount: 0 }
    );
  },
});

export const requeue = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => {
    const job = await ctx.db.get(id);
    if (!job) return;
    const chunks = await ctx.db
      .query("outputChunks")
      .withIndex("by_job", (q) => q.eq("jobId", id))
      .collect();
    for (const c of chunks) await ctx.db.delete(c._id);
    await ctx.db.patch(id, {
      status: "queued",
      output: "",
      error: undefined,
      prUrl: undefined,
      prNumber: undefined,
      startedAt: undefined,
      completedAt: undefined,
    });
  },
});

export const cancel = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) =>
    ctx.db.patch(id, { status: "cancelled", completedAt: Date.now() }),
});

// Of the given job ids, return those whose status is "cancelled". The worker
// passes only the jobs it's actively running, so this stays cheap.
export const cancelledAmong = query({
  args: { ids: v.array(v.id("jobs")) },
  handler: async (ctx, { ids }) => {
    const result: string[] = [];
    for (const id of ids) {
      const job = await ctx.db.get(id);
      if (job?.status === "cancelled") result.push(id);
    }
    return result;
  },
});

export const remove = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});

// ── Delegator ──────────────────────────────────────────────────────────────

// Store the epic's plan + integration branch and flip it into "delegating" so
// the worker's scheduler takes over. Done atomically in one patch.
export const setDelegatorPlan = mutation({
  args: { id: v.id("jobs"), delegatorPlan: v.string(), branch: v.string() },
  handler: async (ctx, { id, delegatorPlan, branch }) => {
    await ctx.db.patch(id, { delegatorPlan, branch, status: "delegating" });
  },
});

// Materialize a planned DAG as child jobs in a single transaction so the graph
// is never observed half-built. Two passes: insert every child (so we have its
// id), then wire up blockedBy from the planner's local ids.
export const createChildren = mutation({
  args: {
    epicId: v.id("jobs"),
    subtasks: v.array(
      v.object({
        localId: v.string(),
        title: v.string(),
        prompt: v.string(),
        touchedPaths: v.array(v.string()),
        dependsOn: v.array(v.string()),
      })
    ),
  },
  handler: async (ctx, { epicId, subtasks }) => {
    const epic = await ctx.db.get(epicId);
    if (!epic) throw new Error("epic not found");

    const idByLocal = new Map<string, Id<"jobs">>();
    const inserted: Id<"jobs">[] = [];
    for (let i = 0; i < subtasks.length; i++) {
      const t = subtasks[i];
      const id = await ctx.db.insert("jobs", {
        projectId: epic.projectId,
        title: t.title,
        prompt: t.prompt,
        images: [],
        status: "pending",
        kind: "task",
        parentJobId: epicId,
        priority: i, // plan order — also the display order in the panel
        touchedPaths: t.touchedPaths,
        blockedBy: [],
        createdAt: Date.now(),
      });
      idByLocal.set(t.localId, id);
      inserted.push(id);
    }

    for (const t of subtasks) {
      const id = idByLocal.get(t.localId)!;
      const blockedBy = t.dependsOn
        .map((dep) => idByLocal.get(dep))
        .filter((x): x is Id<"jobs"> => Boolean(x));
      if (blockedBy.length) await ctx.db.patch(id, { blockedBy });
    }

    return inserted;
  },
});

// All child tasks of an epic, in plan order. Used by the DelegatorPanel and the
// scheduler.
export const childrenOf = query({
  args: { parentJobId: v.id("jobs") },
  handler: async (ctx, { parentJobId }) => {
    const children = await ctx.db
      .query("jobs")
      .withIndex("by_parent", (q) => q.eq("parentJobId", parentJobId))
      .collect();
    return children.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
  },
});

// Every epic currently supervising children, bundled with those children. The
// worker subscribes to this; Convex re-pushes it whenever any epic or child row
// changes, which is the scheduler's wake signal.
export const listDelegationState = query({
  args: {},
  handler: async (ctx) => {
    const epics = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "delegating"))
      .collect();
    const out = [];
    for (const epic of epics) {
      const children = await ctx.db
        .query("jobs")
        .withIndex("by_parent", (q) => q.eq("parentJobId", epic._id))
        .collect();
      children.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
      out.push({ epic, children });
    }
    return out;
  },
});

// Cancel an epic and every child task that hasn't already finished.
export const cancelEpic = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => {
    const now = Date.now();
    const children = await ctx.db
      .query("jobs")
      .withIndex("by_parent", (q) => q.eq("parentJobId", id))
      .collect();
    for (const c of children) {
      if (c.status !== "completed" && c.status !== "cancelled" && c.status !== "failed") {
        await ctx.db.patch(c._id, { status: "cancelled", completedAt: now });
      }
    }
    await ctx.db.patch(id, { status: "cancelled", completedAt: now });
  },
});
