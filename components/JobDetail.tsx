"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { ExternalLink, GitBranch, Clock } from "lucide-react";
import { useEffect, useRef } from "react";

interface Props {
  jobId: Id<"jobs">;
}

export function JobDetail({ jobId }: Props) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const chunks = useQuery(api.jobs.getOutput, { jobId });
  const bottomRef = useRef<HTMLDivElement>(null);

  const output = chunks?.map((c) => c.text).join("") ?? "";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  if (!job) return <div className="p-6 text-zinc-600 text-sm">Loading…</div>;

  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

  const isRunning = job.status === "running";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-[#27272a] flex-shrink-0">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-sm font-semibold text-zinc-100 leading-snug">{job.title}</h2>
          <StatusBadge status={job.status} />
        </div>
        <p className="text-xs text-zinc-500 mb-3 line-clamp-2">{job.prompt}</p>

        <div className="flex items-center gap-3 text-[10px] text-zinc-600 flex-wrap">
          {job.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch}
            </span>
          )}
          {elapsed !== null && (
            <span className="flex items-center gap-1">
              <Clock className="w-2.5 h-2.5" />
              {elapsed}s
            </span>
          )}
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300">
              <ExternalLink className="w-2.5 h-2.5" />
              View PR #{job.prNumber}
            </a>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        <div className="px-4 py-2 border-b border-[#27272a] flex items-center gap-2 flex-shrink-0 bg-[#0d0d0f]">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          </div>
          <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase flex-1 text-center">
            Agent Output
          </span>
          {isRunning && (
            <span className="flex items-center gap-1 text-[10px] text-indigo-400">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              live
            </span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto bg-[#080809] p-4 min-h-0">
          {output ? (
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
              {output.split("\n").map((line, i) => {
                const isFactory = line.startsWith("[factory]");
                const isError = line.includes("ERROR") || line.includes("error");
                const isDivider = /^─+$/.test(line.trim());
                return (
                  <span key={i} className={
                    isDivider ? "text-zinc-800" :
                    isError ? "text-red-400" :
                    isFactory ? "text-indigo-400" :
                    "text-zinc-300"
                  }>
                    {line}{"\n"}
                  </span>
                );
              })}
              {isRunning && (
                <span className="inline-block w-2 h-3.5 bg-indigo-400 animate-pulse ml-0.5 align-middle" />
              )}
            </pre>
          ) : (
            <p className="text-xs text-zinc-700 italic font-mono">
              {job.status === "pending" ? "Waiting to start… click Run on the card" : "No output yet…"}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Error */}
      {job.error && (
        <div className="p-4 border-t border-red-900/50 bg-red-950/20 flex-shrink-0">
          <p className="text-[10px] font-semibold text-red-400 mb-1 uppercase tracking-widest">Error</p>
          <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap">{job.error}</pre>
        </div>
      )}
    </div>
  );
}
