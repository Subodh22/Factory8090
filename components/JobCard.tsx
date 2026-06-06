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
        className="bg-paper border-[3px] border-ink p-3 cursor-pointer brutal-shadow-sm hover:-translate-x-px hover:-translate-y-px hover:shadow-[6px_6px_0_var(--ink)] transition-all group"
        onClick={() => onSelect?.(job._id)}
      >
        <div className="flex items-start justify-between gap-2 mb-2">
          <h5 className="text-[13px] font-bold uppercase text-ink leading-[1.25] flex-1">
            {job.title}
          </h5>
          <StatusBadge status={job.status} />
        </div>

        <p className="font-data text-[11px] text-muted mb-3 leading-[1.45]">{job.prompt}</p>

        {job.images.length > 0 && (
          <div className="flex gap-1 mb-3 flex-wrap">
            {job.images.slice(0, 3).map((img, i) => (
              <img key={i} src={img} alt="" className="w-10 h-10 object-cover border-2 border-ink" />
            ))}
          </div>
        )}

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 font-data text-[10px] text-muted uppercase">
            {job.branch && (
              <span className="flex items-center gap-1">
                <GitBranch className="w-2.5 h-2.5" />
                {job.branch.replace("job/", "").slice(0, 8)}
              </span>
            )}
            {elapsed !== null && <span>{elapsed}s</span>}
            {job.costUsd != null && job.costUsd > 0 && (
              <span className="text-ink" title={`${((job.inputTokens ?? 0) + (job.outputTokens ?? 0)).toLocaleString()} tokens`}>
                ${job.costUsd.toFixed(3)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {job.prUrl && (
              <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
                className="p-1 text-muted hover:text-ink"
                onClick={(e) => e.stopPropagation()}>
                <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {job.status === "pending" && (
              <button
                className="flex items-center gap-1 px-2 py-0.5 font-data text-[10px] uppercase bg-ink text-concrete border-2 border-ink hover:bg-concrete hover:text-ink transition-colors"
                onClick={(e) => { e.stopPropagation(); handleRun(); }}>
                <Play className="w-2.5 h-2.5" /> Run
              </button>
            )}
            {(job.status === "cancelled" || job.status === "failed") && (
              <button
                className="flex items-center gap-1 px-2 py-0.5 font-data text-[10px] uppercase border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors opacity-0 group-hover:opacity-100"
                onClick={openRedo}>
                <RotateCcw className="w-2.5 h-2.5" /> Redo
              </button>
            )}
            {(job.status === "pending" || job.status === "running" || job.status === "queued" || job.status === "waiting_for_input") && (
              <button className="p-1 text-muted hover:text-[#d6210f] opacity-0 group-hover:opacity-100 transition-opacity"
                title="Cancel agent"
                onClick={(e) => { e.stopPropagation(); handleCancel(); }}>
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      </div>

      {showRedoDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40"
          onClick={() => setShowRedoDialog(false)}
        >
          <div
            className="bg-paper border-4 border-ink brutal-shadow p-5 w-[480px] max-w-[90vw]"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display uppercase text-[15px] text-ink mb-4 pb-3 border-b-4 border-ink">Re-run job</h3>

            <div className="mb-3">
              <p className="font-data text-[10px] uppercase text-muted mb-1.5">Original prompt</p>
              <div className="text-xs text-ink bg-concrete border-2 border-ink p-2.5 max-h-28 overflow-y-auto font-mono whitespace-pre-wrap">
                {job.prompt}
              </div>
            </div>

            <div className="mb-5">
              <p className="font-data text-[10px] uppercase text-muted mb-1.5">Additional instructions <span className="opacity-60">(optional)</span></p>
              <textarea
                className="w-full bg-concrete border-2 border-ink p-2.5 text-xs text-ink font-mono resize-none focus:outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] transition-shadow"
                rows={3}
                placeholder="Add more context or updated instructions…"
                value={additionalPrompt}
                onChange={(e) => setAdditionalPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRedo();
                }}
                autoFocus
              />
              <p className="font-data text-[10px] uppercase text-muted mt-1">⌘↵ to submit</p>
            </div>

            <div className="flex justify-end gap-2">
              <button
                className="px-3 py-1.5 font-data text-[11px] uppercase text-muted hover:text-ink transition-colors"
                onClick={() => setShowRedoDialog(false)}
              >
                Cancel
              </button>
              <button
                className="flex items-center gap-1.5 px-3 py-1.5 font-data text-[11px] uppercase bg-ink text-concrete border-2 border-ink brutal-press"
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
