"use client";
import { useState, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Paperclip, Play } from "lucide-react";
import { toast } from "sonner";
import { AttachmentPreview } from "@/components/AttachmentPreview";

interface Props {
  projectId: Id<"projects">;
  onJobCreated?: (id: Id<"jobs">) => void;
}

export function ChatPanel({ projectId, onJobCreated }: Props) {
  const [prompt, setPrompt] = useState("");
  const [attachments, setAttachments] = useState<string[]>([]);
  const [autoRun, setAutoRun] = useState(true);
  const [delegate, setDelegate] = useState(false);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const createJob = useMutation(api.jobs.create);
  const queueJob = useMutation(api.jobs.updateStatus);
  const project = useQuery(api.projects.get, { id: projectId });

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { images: newAttachments, skipped } = await res.json() as { images: string[]; skipped?: string[] };
    setAttachments((prev) => [...prev, ...newAttachments]);
    if (skipped?.length) toast.error(`Too large to attach: ${skipped.join(", ")}`);
  }, []);

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files);
    if (files.length) addFiles(files);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) addFiles(files);
  }

  async function submit() {
    if (!prompt.trim()) return;
    setLoading(true);
    try {
      const title = prompt.slice(0, 80).trim();
      const jobId = await createJob({
        projectId,
        title,
        prompt: prompt.trim(),
        images: attachments,
        kind: delegate ? "epic" : undefined,
      });
      toast.success(delegate ? "Epic created" : "Job created");
      // Epics must always be queued so the worker plans & splits them; for plain
      // jobs the auto-run toggle decides. Queue it on Convex; the local worker
      // polls and runs it. This works from a remote UI (e.g. the Vercel deploy)
      // where the worker lives on a different machine.
      if (autoRun || delegate) {
        await queueJob({ id: jobId, status: "queued" });
        toast.success(delegate ? "Queued — worker will plan the epic" : "Queued — local worker will pick it up");
      }
      onJobCreated?.(jobId);
      setPrompt("");
      setAttachments([]);
    } catch (err) {
      toast.error("Failed to create job");
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
  }

  return (
    <div ref={dropRef} onDrop={onDrop} onDragOver={(e) => e.preventDefault()}>
      <div className="bg-paper border-4 border-ink brutal-shadow grid-bg">
        {/* head */}
        <div className="flex justify-between items-center px-5 py-4 border-b-4 border-ink bg-paper">
          <b className="font-display uppercase text-[15px]">New Job — {project?.name ?? "…"}</b>
          <div className="flex items-center gap-2">
            <button
              className={`font-data text-[11px] px-2.5 py-1.5 uppercase flex items-center gap-1.5 select-none transition-colors ${
                delegate ? "bg-ink text-paper" : "bg-paper text-ink border border-ink"
              }`}
              onClick={() => setDelegate((v) => !v)}
              title="Delegate: plan the task and split it into parallel sub-agents, merged into one PR"
            >
              <span className={`w-[7px] h-[7px] ${delegate ? "bg-[#e0a32e]" : "bg-[#888]"}`} />
              Delegate {delegate ? "on" : "off"}
            </button>
            <button
              className={`font-data text-[11px] px-2.5 py-1.5 uppercase flex items-center gap-1.5 select-none transition-colors ${
                autoRun ? "bg-ink text-paper" : "bg-paper text-ink border border-ink"
              } ${delegate ? "opacity-40 pointer-events-none" : ""}`}
              onClick={() => setAutoRun((v) => !v)}
              title="Auto-run: start executing immediately after creating"
            >
              <span className={`w-[7px] h-[7px] ${autoRun ? "bg-[#3bd16f]" : "bg-[#888]"}`} />
              Auto-run {autoRun ? "on" : "off"}
            </button>
          </div>
        </div>

        {/* body */}
        <div className="p-5 bg-paper">
          {attachments.length > 0 && (
            <div className="flex gap-2 flex-wrap mb-3">
              {attachments.map((src, i) => (
                <AttachmentPreview
                  key={i}
                  src={src}
                  onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder="Describe what you want to build or change…  (paste or drop files, Cmd+Enter to send)"
            className="w-full min-h-[150px] resize-y border-[3px] border-ink bg-concrete p-3.5 font-mono text-[13px] text-ink leading-[1.5] placeholder:text-muted focus:outline-none focus:bg-[#dfdcd4] focus:shadow-[inset_0_0_0_3px_var(--ink)] transition-shadow"
          />
        </div>

        {/* foot */}
        <div className="flex justify-between items-center px-5 py-4 border-t-4 border-ink bg-paper">
          <div className="flex items-center gap-3">
            <button
              className="font-data text-[12px] uppercase flex items-center gap-1.5 border-b-2 border-ink pb-px hover:bg-ink hover:text-paper hover:border-transparent hover:px-1.5 hover:py-0.5 transition-colors"
              onClick={() => fileRef.current?.click()}
            >
              <Paperclip className="w-3.5 h-3.5" />
              Attach files
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => e.target.files && addFiles(e.target.files)}
            />
          </div>

          <button
            onClick={submit}
            disabled={!prompt.trim() || loading}
            className="font-display uppercase text-[14px] bg-ink text-paper px-7 py-3 inline-flex items-center gap-2 brutal-press disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            {delegate ? "Delegate" : autoRun ? "Run" : "Queue"} <Play className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      <p className="font-data text-[10px] text-muted mt-3.5 uppercase text-right">
        or paste / drag-drop · Cmd+Enter to send
      </p>
    </div>
  );
}
