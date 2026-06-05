"use client";
import { useState, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Paperclip, SendHorizontal, Zap } from "lucide-react";
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
      });
      toast.success("Job created");
      if (autoRun) {
        // Queue it on Convex; the local worker polls and runs it. This works
        // from a remote UI (e.g. the Vercel deploy) where the worker lives on
        // a different machine — unlike the old /api/execute route, which tried
        // to spawn Claude on whatever server served the request.
        await queueJob({ id: jobId, status: "queued" });
        toast.success("Queued — local worker will pick it up");
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
    <div
      ref={dropRef}
      className="flex flex-col gap-3 p-4 bg-[#1b1613] border border-[#2e2722] rounded-xl"
      onDrop={onDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-zinc-400 tracking-widest uppercase">
          New Job — {project?.name ?? "…"}
        </p>
        <button
          className={`flex items-center gap-1 text-[10px] px-2 py-1 rounded-full border transition-colors ${
            autoRun
              ? "bg-indigo-950 border-indigo-700 text-indigo-400"
              : "bg-zinc-900 border-zinc-700 text-zinc-500"
          }`}
          onClick={() => setAutoRun((v) => !v)}
          title="Auto-run: start executing immediately after creating"
        >
          <Zap className="w-2.5 h-2.5" />
          Auto-run {autoRun ? "on" : "off"}
        </button>
      </div>

      {attachments.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {attachments.map((src, i) => (
            <AttachmentPreview
              key={i}
              src={src}
              onRemove={() => setAttachments((prev) => prev.filter((_, j) => j !== i))}
            />
          ))}
        </div>
      )}

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder="Describe what you want to build or change…  (paste or drop files, Cmd+Enter to send)"
        className="min-h-[100px] resize-none bg-[#14100e] border-[#2e2722] text-zinc-100 placeholder:text-zinc-700 focus-visible:ring-indigo-700 text-sm"
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
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
          <span className="text-[10px] text-zinc-700">or paste / drag-drop</span>
        </div>

        <Button
          onClick={submit}
          disabled={!prompt.trim() || loading}
          size="sm"
          className="bg-indigo-600 hover:bg-indigo-500 text-white gap-1.5"
        >
          <SendHorizontal className="w-3.5 h-3.5" />
          {autoRun ? "Run" : "Queue"}
        </Button>
      </div>
    </div>
  );
}
