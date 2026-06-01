"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { GitBranch, Clock, ExternalLink } from "lucide-react";
import { useEffect, useRef } from "react";

interface MiniTerminalProps {
  jobId: Id<"jobs">;
  isRunning: boolean;
}

function MiniTerminal({ jobId, isRunning }: MiniTerminalProps) {
  const chunks = useQuery(api.jobs.getOutput, { jobId });
  const bottomRef = useRef<HTMLDivElement>(null);
  const output = chunks?.map((c) => c.text).join("") ?? "";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#080809] p-3 min-h-0 font-mono text-[10px]">
      {output ? (
        <pre className="whitespace-pre-wrap leading-relaxed">
          {output.split("\n").map((line, i) => {
            const isFactory = line.startsWith("[factory]");
            const isError = line.includes("ERROR") || line.includes("error:");
            const isDivider = /^─+$/.test(line.trim());
            return (
              <span key={i} className={
                isDivider ? "text-zinc-800" :
                isError ? "text-red-400" :
                isFactory ? "text-indigo-400" :
                "text-zinc-300"
              }>{line}{"\n"}</span>
            );
          })}
          {isRunning && (
            <span className="inline-block w-1.5 h-3 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
          )}
        </pre>
      ) : (
        <p className="text-zinc-700 italic">
          {isRunning ? "Starting…" : "No output"}
        </p>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

interface AgentCardProps {
  jobId: Id<"jobs">;
}

function AgentCard({ jobId }: AgentCardProps) {
  const job = useQuery(api.jobs.get, { id: jobId });
  if (!job) return null;

  const isRunning = job.status === "running";
  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

  return (
    <div className="flex flex-col bg-[#0d0d0f] border border-[#27272a] rounded-lg overflow-hidden" style={{ height: 320 }}>
      {/* Agent card header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#27272a] flex-shrink-0">
        <div className="flex gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : job.status === "completed" ? "bg-green-700" : "bg-red-700"}`} />
          <div className="w-2 h-2 rounded-full bg-zinc-700" />
          <div className="w-2 h-2 rounded-full bg-zinc-700" />
        </div>
        <span className="text-[10px] text-zinc-500 truncate max-w-[160px] mx-2">{job.title}</span>
        <div className="flex items-center gap-2">
          {elapsed !== null && (
            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
              <Clock className="w-2.5 h-2.5" />{elapsed}s
            </span>
          )}
          <StatusBadge status={job.status} />
        </div>
      </div>

      {/* Branch + PR row */}
      {(job.branch || job.prUrl) && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[#1a1a1d] flex-shrink-0">
          {job.branch && (
            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch}
            </span>
          )}
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300">
              <ExternalLink className="w-2.5 h-2.5" />PR #{job.prNumber}
            </a>
          )}
        </div>
      )}

      <MiniTerminal jobId={jobId} isRunning={isRunning} />

      {job.error && (
        <div className="px-3 py-2 border-t border-red-900/50 bg-red-950/20 flex-shrink-0">
          <p className="text-[10px] text-red-300 font-mono truncate">{job.error}</p>
        </div>
      )}
    </div>
  );
}

interface Props {
  projectId: Id<"projects">;
}

export function AgentsGrid({ projectId }: Props) {
  const jobs = useQuery(api.jobs.list, { projectId }) ?? [];

  const activeJobs = jobs.filter((j) =>
    j.status === "running" || j.status === "queued"
  );
  const recentJobs = jobs
    .filter((j) => j.status === "completed" || j.status === "failed")
    .sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))
    .slice(0, 6);

  const displayJobs = [...activeJobs, ...recentJobs];

  if (displayJobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <div className="w-12 h-12 rounded-full border border-zinc-800 flex items-center justify-center">
          <span className="text-xl">⚡</span>
        </div>
        <p className="text-sm text-zinc-500">No agents running</p>
        <p className="text-xs text-zinc-700">Queue some jobs and click Run All to start parallel execution</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      {activeJobs.length > 0 && (
        <div className="mb-4">
          <p className="text-[10px] font-semibold text-zinc-500 tracking-widest uppercase mb-3">
            Active — {activeJobs.length} agent{activeJobs.length !== 1 ? "s" : ""} running
          </p>
          <div className="grid grid-cols-2 gap-3">
            {activeJobs.map((j) => (
              <AgentCard key={j._id} jobId={j._id} />
            ))}
          </div>
        </div>
      )}
      {recentJobs.length > 0 && (
        <div>
          <p className="text-[10px] font-semibold text-zinc-500 tracking-widest uppercase mb-3">
            Recent
          </p>
          <div className="grid grid-cols-2 gap-3">
            {recentJobs.map((j) => (
              <AgentCard key={j._id} jobId={j._id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
