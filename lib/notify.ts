import type { Id } from "../convex/_generated/dataModel";

export type JobOutcome = "completed" | "failed";

interface NotifyOpts {
  jobId: Id<"jobs">;
  title?: string;
  status: JobOutcome;
  projectName?: string;
  error?: string;
  changedFiles?: string[];
}

/**
 * Email the user when a job reaches a terminal state, via the Resend REST API.
 *
 * Opt-in: a no-op unless both RESEND_API_KEY and NOTIFY_EMAIL are set. Never
 * throws — a notification failure must not break the job flow.
 */
export async function sendJobNotification(opts: NotifyOpts): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!apiKey || !to) return;

  const from = process.env.RESEND_FROM || "Factory <onboarding@resend.dev>";
  const appUrl = process.env.NEXTAUTH_URL || "http://localhost:3001";
  const label = opts.title || String(opts.jobId);
  const verb = opts.status === "completed" ? "completed" : "failed";
  const subject = `[Factory] Job ${verb}: ${label}`;

  const lines: string[] = [`Job "${label}" ${verb}.`];
  if (opts.projectName) lines.push(`Project: ${opts.projectName}`);
  if (opts.status === "completed" && opts.changedFiles?.length) {
    lines.push(`Changed files: ${opts.changedFiles.join(", ")}`);
  }
  if (opts.status === "failed" && opts.error) {
    lines.push(`Error: ${opts.error}`);
  }
  lines.push(`Open Factory: ${appUrl}`);

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text: lines.join("\n") }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[notify] Resend returned ${res.status}: ${body}`);
    }
  } catch (err) {
    console.error(`[notify] failed to send email: ${String(err)}`);
  }
}
