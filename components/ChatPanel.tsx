"use client";
import { useState, useRef, useCallback } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ImageIcon, SendHorizontal, X, Zap } from "lucide-react";
import { toast } from "sonner";

interface Props {
  projectId: Id<"projects">;
  onJobCreated?: (id: Id<"jobs">) => void;
}

export function ChatPanel({ projectId, onJobCreated }: Props) {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [autoRun, setAutoRun] = useState(true);
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const createJob = useMutation(api.jobs.create);
  const project = useQuery(api.projects.get, { id: projectId });

  const addImages = useCallback(async (files: FileList | File[]) => {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { images: newImgs } = await res.json();
    setImages((prev) => [...prev, ...newImgs]);
  }, []);

  function onPaste(e: React.ClipboardEvent) {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) addImages(files);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
    if (files.length) addImages(files);
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
        images,
      });
      toast.success("Job created");
      if (autoRun) {
        await fetch("/api/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        toast.success("Job started");
      }
      onJobCreated?.(jobId);
      setPrompt("");
      setImages([]);
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
      className="flex flex-col gap-3 p-4 bg-[#111113] border border-[#27272a] rounded-xl"
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

      {images.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {images.map((img, i) => (
            <div key={i} className="relative group">
              <img src={img} alt="" className="w-16 h-16 rounded-lg object-cover border border-zinc-800" />
              <button
                className="absolute -top-1.5 -right-1.5 bg-zinc-900 border border-zinc-700 rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <X className="w-2.5 h-2.5 text-zinc-400" />
              </button>
            </div>
          ))}
        </div>
      )}

      <Textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        placeholder="Describe what you want to build or change…  (paste images, Cmd+Enter to send)"
        className="min-h-[100px] resize-none bg-[#0a0a0b] border-[#27272a] text-zinc-100 placeholder:text-zinc-700 focus-visible:ring-indigo-700 text-sm"
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
            onClick={() => fileRef.current?.click()}
          >
            <ImageIcon className="w-3.5 h-3.5" />
            Attach image
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addImages(e.target.files)}
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
