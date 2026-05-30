"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ExternalLink, GitBranch, Clock } from "lucide-react";

interface Props {
  jobId: Id<"jobs">;
}

export function JobDetail({ jobId }: Props) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const chunks = useQuery(api.jobs.getOutput, { jobId });

  if (!job) return <div className="p-6 text-zinc-600 text-sm">Loading…</div>;

  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

  return (
    <div className="flex flex-col h-full">
      <div className="p-4 border-b border-[#27272a]">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-sm font-semibold text-zinc-100 leading-snug">{job.title}</h2>
          <StatusBadge status={job.status} />
        </div>
        <p className="text-xs text-zinc-500 mb-3">{job.prompt}</p>

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
              PR #{job.prNumber}
            </a>
          )}
        </div>

        {job.images.length > 0 && (
          <div className="flex gap-2 mt-3 flex-wrap">
            {job.images.map((img, i) => (
              <img key={i} src={img} alt="" className="w-20 h-20 rounded-lg object-cover border border-zinc-800" />
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="px-4 py-2 border-b border-[#27272a]">
          <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase">
            Agent Output
          </span>
        </div>
        <ScrollArea className="flex-1 p-4">
          <pre className="text-xs text-zinc-400 font-mono whitespace-pre-wrap leading-relaxed">
            {chunks?.map((c) => c.text).join("") || (
              <span className="text-zinc-700 italic">
                {job.status === "pending" ? "Waiting to start…" : "No output yet"}
              </span>
            )}
          </pre>
        </ScrollArea>
      </div>

      {job.error && (
        <div className="p-4 border-t border-red-900 bg-red-950/30">
          <p className="text-xs font-semibold text-red-400 mb-1">Error</p>
          <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap">{job.error}</pre>
        </div>
      )}
    </div>
  );
}
