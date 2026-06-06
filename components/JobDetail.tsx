"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { DelegatorPanel } from "./DelegatorPanel";
import { ExternalLink, GitBranch, Clock, Coins, Paperclip, X, RotateCcw, Plus, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AttachmentPreview } from "./AttachmentPreview";

interface Props {
  jobId: Id<"jobs">;
  onRedo?: (newJobId: Id<"jobs">) => void;
}

type LineType = "tool" | "bash" | "stderr" | "factory" | "error" | "divider" | "text";

// Ephemeral chat message — lives only in component state, never persisted.
type ChatMsg = { id: string; role: "assistant" | "user"; text: string; images?: string[] };

function parseLine(raw: string): { type: LineType; text: string } {
  if (raw.startsWith("\x00tool\x00")) return { type: "tool", text: raw.slice(7) };
  if (raw.startsWith("\x00bash\x00")) return { type: "bash", text: raw.slice(7) };
  if (raw.startsWith("\x00stderr\x00")) return { type: "stderr", text: raw.slice(9) };
  if (raw.startsWith("[factory]")) return { type: "factory", text: raw };
  if (/^─+$/.test(raw.trim())) return { type: "divider", text: raw };
  if (/ERROR|FATAL/.test(raw)) return { type: "error", text: raw };
  return { type: "text", text: raw };
}

function lineClass(type: LineType): string {
  // Rendered on the dark terminal slab — explicit light colours, not the
  // inverted zinc ramp (which would be dark-on-dark).
  switch (type) {
    case "tool":    return "text-cyan-400";
    case "bash":    return "text-amber-300";
    case "stderr":  return "text-[#6b8a6b]";
    case "factory": return "text-[#3bd16f]";
    case "error":   return "text-red-400";
    case "divider": return "text-[#4a4a44]";
    case "text":    return "text-[#cfe8cf]";
  }
}

const SSE_BASE = process.env.NEXT_PUBLIC_WORKER_SSE_URL ?? "http://localhost:3099";

export function JobDetail({ jobId, onRedo }: Props) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const appendPrompt = useMutation(api.jobs.appendPrompt);
  const redo = useMutation(api.jobs.redo);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [promptDraft, setPromptDraft] = useState("");
  const [addingPrompt, setAddingPrompt] = useState(false);
  const [sseOutput, setSseOutput] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Ephemeral chat thread — user replies + assistant bubbles streamed over SSE.
  // Reset when switching jobs; lost on reload (never persisted, like output).
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  // Reset the thread when switching jobs.
  useEffect(() => { setMessages([]); }, [jobId]);

  // Redo panel state — re-run a finished job with optional extra prompt/images
  const [redoOpen, setRedoOpen] = useState(false);
  const [redoPrompt, setRedoPrompt] = useState("");
  const [redoImages, setRedoImages] = useState<string[]>([]);
  const [redoing, setRedoing] = useState(false);
  const redoFileInputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  // Output is streamed live over SSE only (never persisted), so there is no
  // stored log to fall back to — finished jobs show no terminal history.
  const convexOutput = "";

  const isRunning = job?.status === "running";
  // Claude asked a question and is paused — reply in the chat panel to continue
  const isWaiting = job?.status === "waiting_for_input";
  // Epic supervising its child tasks (the Delegator scheduler is driving it)
  const isDelegating = job?.status === "delegating";
  const isEpic = job?.kind === "epic";
  // Backlog job not yet started — user can still edit/grow the prompt
  const isPending = job?.status === "pending" || job?.status === "queued";
  // "Done" jobs that can be re-run from scratch
  const isFinished = job?.status === "completed" || job?.status === "failed" || job?.status === "cancelled";
  // Keep the live SSE connection open while running OR waiting, so chat
  // replies stream back immediately without a Convex round-trip first. Epics
  // also stream while delegating (planner + scheduler logs).
  const streamActive = isRunning || isWaiting || isDelegating;

  // Live clock — ticks every second while running so elapsed time updates
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  // SSE streaming while running
  const convexOutputRef = useRef(convexOutput);
  convexOutputRef.current = convexOutput;

  useEffect(() => {
    if (!streamActive) {
      setSseOutput(null);
      return;
    }

    let accumulated = convexOutputRef.current;
    setSseOutput(accumulated);

    const es = new EventSource(`${SSE_BASE}/stream/${encodeURIComponent(jobId)}`);

    es.onmessage = (e) => {
      try {
        const { text } = JSON.parse(e.data) as { text: string };
        accumulated += text;
        setSseOutput(accumulated);
      } catch { /* ignore malformed events */ }
    };

    // Full assistant turns arrive as a named `chat` event → chat thread bubbles
    es.addEventListener("chat", (e) => {
      try {
        const msg = JSON.parse((e as MessageEvent).data) as { role: "assistant" | "user"; text: string; images?: string[] };
        setMessages((prev) => [...prev, { ...msg, id: `${Date.now()}-${prev.length}` }]);
      } catch { /* ignore malformed events */ }
    });

    es.onerror = () => {
      setSseOutput(null);
      es.close();
    };

    return () => {
      es.close();
      setSseOutput(null);
    };
  }, [jobId, streamActive]);

  // Use SSE output while live (fast path), Convex output otherwise (source of truth)
  const output = (streamActive && sseOutput !== null) ? sseOutput : convexOutput;
  // Chat is available on any started job: running/waiting talk to the live
  // session; a finished job is resumed by its saved session id on first reply.
  // Epics aren't chatted with directly — you talk to their child tasks instead.
  const canChat = !!job && !isPending && !isEpic;

  // Track when output last changed so we can show silence duration
  const lastOutputAt = useRef(Date.now());
  const prevOutputLen = useRef(0);
  if (output.length !== prevOutputLen.current) {
    lastOutputAt.current = Date.now();
    prevOutputLen.current = output.length;
  }

  // Seconds since last output chunk arrived (0 when not running)
  const silentSecs = isRunning ? Math.floor((now - lastOutputAt.current) / 1000) : 0;

  // Derive the last active tool for the live status pill
  const lines = output.split("\n").filter(Boolean);
  const lastToolLine = [...lines].reverse().find((l) => l.startsWith("\x00tool\x00") || l.startsWith("\x00bash\x00"));
  const activeTool = isRunning && lastToolLine
    ? lastToolLine.slice(7)
    : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output, messages]);

  async function handleFilePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { images, skipped } = await res.json() as { images: string[]; skipped?: string[] };
    setAttachedFiles((prev) => [...prev, ...images]);
    if (skipped?.length) toast.error(`Too large to attach: ${skipped.join(", ")}`);
    e.target.value = "";
  }

  async function handleRedoImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    if (!files.length) return;
    const form = new FormData();
    files.forEach((f) => form.append("files", f));
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const { images } = await res.json() as { images: string[] };
    setRedoImages((prev) => [...prev, ...images]);
    e.target.value = "";
  }

  async function handleRedo(e: React.FormEvent) {
    e.preventDefault();
    if (redoing) return;
    setRedoing(true);
    try {
      const newJobId = await redo({
        sourceJobId: jobId,
        extraPrompt: redoPrompt.trim() || undefined,
        extraImages: redoImages.length ? redoImages : undefined,
      });
      setRedoOpen(false);
      setRedoPrompt("");
      setRedoImages([]);
      toast.success("Re-running — queued a fresh agent");
      onRedo?.(newJobId);
    } finally {
      setRedoing(false);
    }
  }

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if ((!reply.trim() && !attachedFiles.length) || sending) return;
    setSending(true);
    const text = reply.trim();
    const images = attachedFiles;
    // Optimistically show the user's bubble; the assistant's reply streams back
    // over SSE. Nothing is persisted — POST goes straight to the worker.
    setMessages((prev) => [...prev, { id: `${Date.now()}-u`, role: "user", text, images: images.length ? images : undefined }]);
    setReply("");
    setAttachedFiles([]);
    try {
      const res = await fetch(`${SSE_BASE}/reply/${encodeURIComponent(jobId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, images }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "failed to deliver" }));
        toast.error(error ?? "Could not reach the worker");
      }
    } catch {
      toast.error("Could not reach the worker — is it running?");
    } finally {
      setSending(false);
    }
  }

  async function handleAddPrompt(e: React.FormEvent) {
    e.preventDefault();
    if ((!promptDraft.trim() && !attachedFiles.length) || addingPrompt) return;
    setAddingPrompt(true);
    try {
      await appendPrompt({
        id: jobId,
        text: promptDraft.trim(),
        images: attachedFiles.length ? attachedFiles : undefined,
      });
      setPromptDraft("");
      setAttachedFiles([]);
      toast.success("Added to prompt");
    } finally {
      setAddingPrompt(false);
    }
  }

  if (!job) return <div className="p-6 text-muted font-data text-xs uppercase">Loading...</div>;

  // Live elapsed: counts up while running, freezes when done
  const elapsed = job.startedAt
    ? Math.round(((isRunning ? now : (job.completedAt ?? now)) - job.startedAt) / 1000)
    : null;

  const isThinking = isRunning && silentSecs >= 8;
  const isStuck = isRunning && silentSecs >= 30;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b-4 border-ink flex-shrink-0 bg-concrete">
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-sm font-bold uppercase text-ink leading-snug">{job.title}</h2>
          <StatusBadge status={job.status} />
        </div>
        <p className={`font-data text-[11px] text-muted mb-3 whitespace-pre-wrap ${isPending ? "" : "line-clamp-2"}`}>{job.prompt}</p>

        <div className="flex items-center gap-3 font-data text-[10px] uppercase text-muted flex-wrap">
          {job.branch && (
            <span className="flex items-center gap-1">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch}
            </span>
          )}
          {elapsed !== null && (
            <span className={`flex items-center gap-1 ${isRunning ? "text-ink font-bold" : ""}`}>
              <Clock className="w-2.5 h-2.5" />
              {elapsed}s
            </span>
          )}
          {job.costUsd != null && job.costUsd > 0 && (
            <span className="flex items-center gap-1 text-ink" title={`Input: ${(job.inputTokens ?? 0).toLocaleString()} · Output: ${(job.outputTokens ?? 0).toLocaleString()}`}>
              <Coins className="w-2.5 h-2.5" />
              ${job.costUsd.toFixed(4)} · {((job.inputTokens ?? 0) + (job.outputTokens ?? 0)).toLocaleString()} tok
            </span>
          )}
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-ink underline hover:no-underline">
              <ExternalLink className="w-2.5 h-2.5" />
              View PR #{job.prNumber}
            </a>
          )}
          {isFinished && (
            <button
              onClick={() => setRedoOpen((o) => !o)}
              className="flex items-center gap-1 px-2 py-0.5 ml-auto font-data text-[10px] uppercase border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors"
              title="Re-run this job from scratch"
            >
              <RotateCcw className="w-2.5 h-2.5" />
              Redo
            </button>
          )}
        </div>

        {/* Redo panel — re-run with optional extra prompt / images */}
        {isFinished && redoOpen && (
          <form onSubmit={handleRedo} className="mt-3 p-3 border-2 border-ink bg-paper space-y-2">
            <p className="font-data text-[10px] uppercase text-muted">
              Re-runs in a fresh worktree. Add extra instructions or images below (optional).
            </p>
            <textarea
              value={redoPrompt}
              onChange={(e) => setRedoPrompt(e.target.value)}
              placeholder="Anything to change or add this time… (optional)"
              rows={2}
              className="w-full bg-concrete border-2 border-ink px-3 py-2 font-mono text-xs text-ink placeholder:text-muted focus:outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] resize-none"
            />
            {redoImages.length > 0 && (
              <div className="flex gap-2 flex-wrap">
                {redoImages.map((src, i) => (
                  <div key={i} className="relative group">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt="" className="h-14 w-14 object-cover border-2 border-ink" />
                    <button
                      type="button"
                      onClick={() => setRedoImages((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1 -right-1 w-4 h-4 bg-ink border border-ink flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X className="w-2.5 h-2.5 text-concrete" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input ref={redoFileInputRef} type="file" accept="image/*" multiple className="hidden" onChange={handleRedoImagePick} />
              <button
                type="button"
                onClick={() => redoFileInputRef.current?.click()}
                className="px-2 py-1.5 bg-concrete border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors"
                title="Attach image"
              >
                <Paperclip className="w-3.5 h-3.5" />
              </button>
              <button
                type="submit"
                disabled={redoing}
                className="px-3 py-1.5 bg-ink text-concrete border-2 border-ink disabled:opacity-40 font-data text-[10px] uppercase flex items-center gap-1 brutal-press"
              >
                <RotateCcw className="w-3 h-3" />
                {redoing ? "Queuing…" : "Run again"}
              </button>
              <button
                type="button"
                onClick={() => setRedoOpen(false)}
                className="px-2 py-1.5 font-data text-[10px] uppercase text-muted hover:text-ink transition-colors"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Terminal output */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {/* Indeterminate activity bar — scrolls while running */}
        {isRunning && (
          <div className="h-1 w-full bg-[#2a2722] flex-shrink-0 overflow-hidden relative">
            <style>{`@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}`}</style>
            <div
              className={`absolute h-full w-1/3 ${isStuck ? "bg-red-500" : isThinking ? "bg-amber-500" : "bg-[#3bd16f]"}`}
              style={{ animation: "slide 2s linear infinite" }}
            />
          </div>
        )}
        <div className="px-4 py-2 border-b-2 border-[#2a2722] flex items-center gap-2 flex-shrink-0 bg-ink">
          <span className="font-data text-[10px] text-[#6b8a6b] tracking-widest uppercase flex-1">
            Agent Output
          </span>
          {isRunning && isStuck ? (
            <span className="flex items-center gap-1.5 font-data text-[10px] text-red-400">
              <span className="w-1.5 h-1.5 bg-red-400 animate-pulse flex-shrink-0" />
              no output {silentSecs}s
            </span>
          ) : isRunning && isThinking ? (
            <span className="flex items-center gap-1.5 font-data text-[10px] text-amber-400">
              <span className="w-1.5 h-1.5 bg-amber-400 animate-pulse flex-shrink-0" />
              thinking...
            </span>
          ) : isRunning && activeTool ? (
            <span className="flex items-center gap-1.5 font-data text-[10px] text-cyan-400 max-w-[160px] truncate">
              <span className="w-1.5 h-1.5 bg-cyan-400 animate-pulse flex-shrink-0" />
              {activeTool}
            </span>
          ) : isRunning ? (
            <span className="flex items-center gap-1 font-data text-[10px] text-[#3bd16f]">
              <span className="w-1.5 h-1.5 bg-[#3bd16f] animate-pulse" />
              live
            </span>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto bg-ink p-4 min-h-0">
          {output ? (
            <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed">
              {output.split("\n").map((raw, i) => {
                if (!raw) return <span key={i}>{"\n"}</span>;
                const { type, text } = parseLine(raw);
                return (
                  <span key={i} className={lineClass(type)}>
                    {text}{"\n"}
                  </span>
                );
              })}
              {isRunning && (
                <span className="inline-block w-2 h-3.5 bg-[#3bd16f] animate-pulse ml-0.5 align-middle opacity-60" />
              )}
            </pre>
          ) : (
            <p className="text-xs text-[#6b8a6b] italic font-mono">
              {job.status === "pending" ? "Waiting to start… click Run on the card" : "No output yet…"}
            </p>
          )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Delegator: the epic's child-task DAG with live status + output */}
      {isEpic && <DelegatorPanel epicId={jobId} />}

      {/* Chat thread — ephemeral (lives in component state, not Convex) */}
      {messages.length > 0 && (
        <div className="border-t-4 border-ink flex-shrink-0 max-h-64 overflow-y-auto bg-concrete">
          <div className="px-4 py-2 border-b-2 border-ink">
            <span className="font-data text-[10px] text-muted tracking-widest uppercase">
              Chat
            </span>
          </div>
          <div className="p-4 space-y-3">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                <div className="font-data text-[10px] font-bold uppercase mt-0.5 flex-shrink-0 text-ink">
                  {msg.role === "assistant" ? "Claude" : "You"}
                </div>
                <div className={`text-xs px-3 py-2 max-w-[85%] whitespace-pre-wrap border-2 border-ink ${
                  msg.role === "assistant"
                    ? "bg-paper text-ink"
                    : "bg-ink text-concrete"
                }`}>
                  {msg.images && msg.images.length > 0 && (
                    <div className="flex gap-1.5 flex-wrap mb-1.5">
                      {msg.images.map((src, i) => (
                        <AttachmentPreview key={i} src={src} size={64} />
                      ))}
                    </div>
                  )}
                  {msg.text}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add-to-prompt — backlog jobs can grow their prompt before they run */}
      {isPending && (
        <div className="border-t-4 border-ink bg-concrete p-3 flex-shrink-0">
          <p className="font-data text-[10px] uppercase text-muted mb-2">
            Add instructions or images before this job runs
          </p>
          {attachedFiles.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attachedFiles.map((src, i) => (
                <AttachmentPreview
                  key={i}
                  src={src}
                  size={56}
                  onRemove={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          <form onSubmit={handleAddPrompt} className="flex gap-2">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2 py-2 bg-paper border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors flex-shrink-0"
              title="Attach files"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <input
              value={promptDraft}
              onChange={(e) => setPromptDraft(e.target.value)}
              placeholder="Add to prompt..."
              className="flex-1 bg-paper border-2 border-ink px-3 py-2 font-mono text-xs text-ink placeholder:text-muted focus:outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] transition-shadow"
            />
            <button
              type="submit"
              disabled={(!promptDraft.trim() && !attachedFiles.length) || addingPrompt}
              className="px-3 py-2 bg-ink text-concrete border-2 border-ink disabled:opacity-40 font-data text-[10px] uppercase flex items-center gap-1 brutal-press"
            >
              <Plus className="w-3 h-3" />
              {addingPrompt ? "..." : "Add"}
            </button>
          </form>
        </div>
      )}

      {/* Chat input — talk to the live agent (running or waiting for a reply) */}
      {canChat && (
        <div className={`border-t-4 p-3 flex-shrink-0 ${
          isWaiting ? "border-ink bg-[#b8860b]/15" : "border-ink bg-concrete"
        }`}>
          {isWaiting && (
            <p className="font-data text-[10px] uppercase text-[#b8860b] mb-2 font-bold">
              Claude has a question — reply to continue
            </p>
          )}
          {isRunning && (
            <p className="font-data text-[10px] uppercase text-muted mb-2">
              Message will be delivered when Claude finishes this turn
            </p>
          )}
          {isFinished && (
            <p className="font-data text-[10px] uppercase text-muted mb-2">
              Continue the conversation — resumes this job&apos;s session
            </p>
          )}
          {attachedFiles.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {attachedFiles.map((src, i) => (
                <AttachmentPreview
                  key={i}
                  src={src}
                  size={56}
                  onRemove={() => setAttachedFiles((prev) => prev.filter((_, j) => j !== i))}
                />
              ))}
            </div>
          )}
          <form onSubmit={handleReply} className="flex gap-2">
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFilePick} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="px-2 py-2 bg-paper border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors flex-shrink-0"
              title="Attach files"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={isWaiting ? "Reply to Claude..." : isRunning ? "Queue a message..." : "Message Claude..."}
              className="flex-1 bg-paper border-2 border-ink px-3 py-2 font-mono text-xs text-ink placeholder:text-muted focus:outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] transition-shadow"
              autoFocus={isWaiting}
            />
            <button
              type="submit"
              disabled={(!reply.trim() && !attachedFiles.length) || sending}
              className="px-3 py-2 bg-ink text-concrete border-2 border-ink disabled:opacity-40 font-data text-[10px] uppercase flex items-center gap-1 brutal-press"
            >
              <Send className="w-3 h-3" />
              {sending ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}

      {/* Error */}
      {job.error && (
        <div className="p-4 border-t-4 border-[#d6210f] bg-[#d6210f]/15 flex-shrink-0">
          <p className="font-data text-[10px] font-bold text-[#d6210f] mb-1 uppercase tracking-widest">Error</p>
          <pre className="text-xs text-[#a8190b] font-mono whitespace-pre-wrap">{job.error}</pre>
        </div>
      )}
    </div>
  );
}
