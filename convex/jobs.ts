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

export const updateStatus = mutation({
  args: {
    id: v.id("jobs"),
    status: v.union(
      v.literal("pending"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    worktreePath: v.optional(v.string()),
    branch: v.optional(v.string()),
    error: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    touchedPaths: v.optional(v.array(v.string())),
    delegatorPlan: v.optional(v.string()),
  },
  handler: async (ctx, { id, status, ...fields }) => {
    const updates: Record<string, unknown> = { status, ...fields };
    if (status === "running") updates.startedAt = Date.now();
    if (status === "completed" || status === "failed") updates.completedAt = Date.now();
    await ctx.db.patch(id, updates);
  },
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

export const cancel = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) =>
    ctx.db.patch(id, { status: "cancelled", completedAt: Date.now() }),
});

export const remove = mutation({
  args: { id: v.id("jobs") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});
