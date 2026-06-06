import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  projects: defineTable({
    name: v.string(),
    repo: v.string(),           // "org/repo"
    localPath: v.string(),      // absolute path on disk
    defaultBranch: v.string(),
    githubToken: v.optional(v.string()),
    sessionPrefix: v.optional(v.string()),
    agentRules: v.optional(v.string()),
    color: v.optional(v.string()),
  }).index("by_repo", ["repo"]),

  jobs: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    prompt: v.string(),
    images: v.array(v.string()),  // base64 data URLs
    status: v.union(
      v.literal("pending"),
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
      v.literal("waiting_for_input")
    ),
    // Legacy field from the old Convex-backed chat — chat is now ephemeral and
    // never writes this, but old job docs may still carry it, so keep it optional.
    lastUserMessageAt: v.optional(v.number()),
    sessionId: v.optional(v.string()),
    priority: v.number(),          // lower = higher priority
    touchedPaths: v.array(v.string()),  // files/dirs this job will touch
    blockedBy: v.array(v.id("jobs")),   // jobs that must finish first
    worktreePath: v.optional(v.string()),
    branch: v.optional(v.string()),
    prUrl: v.optional(v.string()),
    prNumber: v.optional(v.number()),
    output: v.optional(v.string()),   // accumulated Claude output
    error: v.optional(v.string()),
    githubIssueNumber: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    createdAt: v.number(),
    delegatorPlan: v.optional(v.string()),  // JSON: subtasks from Delegator
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_status", ["status"])
    .index("by_project_status", ["projectId", "status"]),

  // Vestigial: chat is now ephemeral (streamed over SSE, never persisted). This
  // table is kept only so any rows written by the old Convex-backed chat still
  // validate. Nothing writes to it anymore.
  jobMessages: defineTable({
    jobId: v.id("jobs"),
    role: v.union(v.literal("assistant"), v.literal("user")),
    text: v.string(),
    images: v.optional(v.array(v.string())),
    ts: v.number(),
  }).index("by_job", ["jobId"]),

  outputChunks: defineTable({
    jobId: v.id("jobs"),
    text: v.string(),
    ts: v.number(),
  }).index("by_job", ["jobId"]),

  // High-churn browser presence — one row per open tab, refreshed on a heartbeat.
  // The worker reads this to decide whether to email (no browser) or rely on the
  // in-app popup (browser open).
  presence: defineTable({
    clientId: v.string(),
    lastSeen: v.number(),
  }).index("by_client", ["clientId"]),

  githubIssues: defineTable({
    projectId: v.id("projects"),
    number: v.number(),
    title: v.string(),
    body: v.string(),
    state: v.string(),
    labels: v.array(v.string()),
    assignee: v.optional(v.string()),
    url: v.string(),
    jobId: v.optional(v.id("jobs")),
    syncedAt: v.number(),
  })
    .index("by_project", ["projectId"])
    .index("by_project_number", ["projectId", "number"]),
});
