import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const list = query({
  args: {},
  handler: async (ctx) => ctx.db.query("projects").collect(),
});

export const get = query({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const create = mutation({
  args: {
    name: v.string(),
    repo: v.string(),
    localPath: v.string(),
    defaultBranch: v.string(),
    githubToken: v.optional(v.string()),
    sessionPrefix: v.optional(v.string()),
    agentRules: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, args) => ctx.db.insert("projects", args),
});

export const update = mutation({
  args: {
    id: v.id("projects"),
    name: v.optional(v.string()),
    localPath: v.optional(v.string()),
    githubToken: v.optional(v.string()),
    agentRules: v.optional(v.string()),
    color: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...fields }) => ctx.db.patch(id, fields),
});

export const remove = mutation({
  args: { id: v.id("projects") },
  handler: async (ctx, { id }) => ctx.db.delete(id),
});
