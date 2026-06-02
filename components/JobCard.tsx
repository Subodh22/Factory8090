"use client";
import { StatusBadge } from "./StatusBadge";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ExternalLink, X, Play, GitBranch } from "lucide-react";
import { toast } from "sonner";

interface Job {
  _id: Id<"jobs">;
  title: string;
  status: string;
  prompt: string;
  images: string[];
  prUrl?: string;
  branch?: string;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export function JobCard({ job, onSelect }: { job: Job; onSelect?: (id: Id<"jobs">) => void }) {
  const cancel = useMutation(api.jobs.cancel);
  const markQueued = useMutation(api.jobs.updateStatus);

  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

  async function handleRun() {
    await markQueued({ id: job._id, status: "queued" });
    toast.success("Queued — local worker will pick it up");
  }

  async function handleCancel() {
    await fetch("/api/execute", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: job._id }),
    });
    await cancel({ id: job._id });
    toast.info("Job cancelled");
  }

  return (
    <div
      className="bg-[#111113] border border-[#27272a] rounded-lg p-3 cursor-pointer hover:border-indigo-700 transition-colors group"
      onClick={() => onSelect?.(job._id)}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-sm font-medium text-zinc-100 leading-snug line-clamp-2 flex-1">
          {job.title}
        </p>
        <StatusBadge status={job.status} />
      </div>

      <p className="text-xs text-zinc-500 line-clamp-2 mb-3">{job.prompt}</p>

      {job.images.length > 0 && (
        <div className="flex gap-1 mb-3 flex-wrap">
          {job.images.slice(0, 3).map((img, i) => (
            <img key={i} src={img} alt="" className="w-10 h-10 rounded object-cover border border-zinc-800" />
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-zinc-600">
          {job.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch.replace("job/", "").slice(0, 8)}
            </span>
          )}
          {elapsed !== null && <span>{elapsed}s</span>}
          {job.costUsd != null && job.costUsd > 0 && (
            <span className="text-zinc-500" title={`${((job.inputTokens ?? 0) + (job.outputTokens ?? 0)).toLocaleString()} tokens`}>
              ${job.costUsd.toFixed(3)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1">
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="p-1 text-zinc-500 hover:text-indigo-400"
              onClick={(e) => e.stopPropagation()}>
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {job.status === "pending" && (
            <button
              className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
              onClick={(e) => { e.stopPropagation(); handleRun(); }}>
              <Play className="w-2.5 h-2.5" /> Run
            </button>
          )}
          {(job.status === "pending" || job.status === "running" || job.status === "queued") && (
            <button className="p-1 text-zinc-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={(e) => { e.stopPropagation(); handleCancel(); }}>
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
