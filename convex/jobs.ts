import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

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
        q.eq("status", status as "pending" | "queued" | "running" | "completed" | "failed" | "cancelled")
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
    });
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
      v.literal("waiting_for_input")
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

export const addMessage = mutation({
  args: {
    jobId: v.id("jobs"),
    role: v.union(v.literal("assistant"), v.literal("user")),
    text: v.string(),
    images: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { jobId, role, text, images }) => {
    await ctx.db.insert("jobMessages", { jobId, role, text, images, ts: Date.now() });
    if (role === "user") {
      await ctx.db.patch(jobId, { lastUserMessageAt: Date.now() });
    }
  },
});

export const listMessages = query({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, { jobId }) =>
    ctx.db
      .query("jobMessages")
      .withIndex("by_job", (q) => q.eq("jobId", jobId))
      .order("asc")
      .collect(),
});

export const appendOutput = mutation({
  args: { jobId: v.id("jobs"), text: v.string() },
  handler: async (ctx, { jobId, text }) => {
    await ctx.db.insert("outputChunks", { jobId, text, ts: Date.now() });
    const job = await ctx.db.get(jobId);
    if (job) {
      await ctx.db.patch(jobId, { output: (job.output ?? "") + text });
    }
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

    // Clear prior run output so the redo starts with a fresh terminal
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

export const remove = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});
