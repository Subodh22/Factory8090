import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Refresh (or create) the heartbeat for one browser tab. Called on an interval
 *  while the tab is open. */
export const heartbeat = mutation({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const existing = await ctx.db
      .query("presence")
      .withIndex("by_client", (q) => q.eq("clientId", clientId))
      .unique();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, { lastSeen: now });
    } else {
      await ctx.db.insert("presence", { clientId, lastSeen: now });
    }
  },
});

/** True if any browser sent a heartbeat at or after `since`. The caller passes
 *  the cutoff because queries cannot read the clock. */
export const anyOnline = query({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    // One row per tab — the table stays tiny, so a bounded scan is plenty.
    const rows = await ctx.db.query("presence").order("desc").take(50);
    return rows.some((r) => r.lastSeen >= since);
  },
});
