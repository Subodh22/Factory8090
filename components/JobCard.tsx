"use client";
import { StatusBadge } from "./StatusBadge";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { ExternalLink, X, Play, GitBranch, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { useState } from "react";

interface Job {
  _id: Id<"jobs">;
  projectId: Id<"projects">;
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
  const createJob = useMutation(api.jobs.create);
  const [showRedoDialog, setShowRedoDialog] = useState(false);
  const [additionalPrompt, setAdditionalPrompt] = useState("");

  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

  async function handleRun() {
    await markQueued({ id: job._id, status: "queued" });
    toast.success("Queued — local worker will pick it up");
  }

  async function handleCancel() {
    // Setting status to "cancelled" is enough: the local worker polls
    // jobs.cancelledAmong every tick and stops the running agent. Works from a
    // remote UI where the worker is on another machine.
    await cancel({ id: job._id });
    toast.info("Job cancelled");
  }

  async function handleRedo() {
    const combined = additionalPrompt.trim()
      ? `${job.prompt}\n\n${additionalPrompt.trim()}`
      : job.prompt;
    await createJob({
      projectId: job.projectId,
      title: job.title,
      prompt: combined,
      images: job.images,
    });
    setShowRedoDialog(false);
    setAdditionalPrompt("");
    toast.success("Job re-created as pending");
  }

  function openRedo(e: React.MouseEvent) {
    e.stopPropagation();
    setAdditionalPrompt("");
    setShowRedoDialog(true);
  }

  return (
    <>
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
            {(job.status === "cancelled" || job.status === "failed") && (
              <button
                className="flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-zinc-700 hover:bg-zinc-600 text-white transition-colors opacity-0 group-hover:opacity-100"
                onClick={openRedo}>
                <RotateCcw className="w-2.5 h-2.5" /> Redo
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

      {showRedoDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          onClick={() => setShowRedoDialog(false)}
        >
          <div
            className="bg-[#18181b] border border-zinc-700 rounded-xl p-5 w-[480px] max-w-[90vw] shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-zinc-100 mb-4">Re-run job</h3>

            <div className="mb-3">
              <p className="text-[11px] text-zinc-500 mb-1.5">Original prompt</p>
              <div className="text-xs text-zinc-400 bg-zinc-900 rounded p-2.5 max-h-28 overflow-y-auto font-mono whitespace-pre-wrap">
                {job.prompt}
              </div>
            </div>

            <div className="mb-5">
              <p className="text-[11px] text-zinc-500 mb-1.5">Additional instructions <span className="text-zinc-600">(optional)</span></p>
              <textarea
                className="w-full bg-zinc-900 border border-zinc-700 rounded p-2.5 text-xs text-zinc-200 resize-none focus:outline-none focus:border-indigo-500 transition-colors"
                rows={3}
                placeholder="Add more context or updated instructions…"
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRedo();
                }}
                autoFocus
              />
              <p className="text-[10px] text-zinc-600 mt-1">⌘↵ to submit</p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
                onClick={() => setShowRedoDialog(false)}
              >
                Cancel
              </button>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 rounded text-xs bg-indigo-600 hover:bg-indigo-500 text-white transition-colors"
                onClick={handleRedo}
              >
                <RotateCcw className="w-3 h-3" /> Re-run
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
