import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) =>
    ctx.db
      .query("githubIssues")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .collect(),
});

export const upsert = mutation({
  args: {
    projectId: v.id("projects"),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.string(),
    labels: v.array(v.string()),
    assignee: v.optional(v.string()),
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("githubIssues")
      .withIndex("by_project_number", (q) =>
        q.eq("projectId", args.projectId).eq("number", args.number)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, { ...args, syncedAt: Date.now() });
      return existing._id;
    }
    return ctx.db.insert("githubIssues", { ...args, syncedAt: Date.now() });
  },
});

export const linkJob = mutation({
  args: { id: v.id("githubIssues"), jobId: v.id("jobs") },
  handler: async (ctx, { id, jobId }) => ctx.db.patch(id, { jobId }),
});
