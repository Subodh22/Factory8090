"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { ExternalLink, GitBranch, Clock, Send, Coins, Paperclip } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AttachmentPreview } from "@/components/AttachmentPreview";

interface Props {
  jobId: Id<"jobs">;
}

type LineType = "tool" | "bash" | "stderr" | "factory" | "error" | "divider" | "text";

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
  switch (type) {
    case "tool":    return "text-cyan-400";
    case "bash":    return "text-amber-300";
    case "stderr":  return "text-zinc-600";
    case "factory": return "text-indigo-400";
    case "error":   return "text-red-400";
    case "divider": return "text-zinc-800";
    case "text":    return "text-zinc-300";
  }
}

const SSE_BASE = process.env.NEXT_PUBLIC_WORKER_SSE_URL ?? "http://localhost:3099";

export function JobDetail({ jobId }: Props) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const chunks = useQuery(api.jobs.getOutput, { jobId });
  const messages = useQuery(api.jobs.listMessages, { jobId });
  const addMessage = useMutation(api.jobs.addMessage);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<string[]>([]);
  const [sseOutput, setSseOutput] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const convexOutput = chunks?.map((c) => c.text).join("") ?? "";

  const isWaiting = job?.status === "waiting_for_input";
  const isRunning = job?.status === "running";

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
    if (!isRunning) {
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

    es.onerror = () => {
      setSseOutput(null);
      es.close();
    };

    return () => {
      es.close();
      setSseOutput(null);
    };
  }, [jobId, isRunning]);

  // Use SSE output while running (fast path), Convex output otherwise (source of truth)
  const output = (isRunning && sseOutput !== null) ? sseOutput : convexOutput;
  const canChat = job?.status !== "pending";

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

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if ((!reply.trim() && !attachedFiles.length) || sending) return;
    setSending(true);
    try {
      await addMessage({ jobId, role: "user", text: reply.trim(), images: attachedFiles.length ? attachedFiles : undefined });
      setReply("");
      setAttachedFiles([]);
    } finally {
      setSending(false);
    }
  }

  if (!job) return <div className="p-6 text-zinc-600 text-sm">Loading...</div>;

  // Live elapsed: counts up while running, freezes when done
  const elapsed = job.startedAt
    ? Math.round(((isRunning ? now : (job.completedAt ?? now)) - job.startedAt) / 1000)
    : null;

  const isThinking = isRunning && silentSecs >= 8;
  const isStuck = isRunning && silentSecs >= 30;

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
            <span className={`flex items-center gap-1 ${isRunning ? "text-zinc-400" : ""}`}>
              <Clock className="w-2.5 h-2.5" />
              {elapsed}s
            </span>
          )}
          {job.costUsd != null && job.costUsd > 0 && (
            <span className="flex items-center gap-1 text-zinc-500" title={`Input: ${(job.inputTokens ?? 0).toLocaleString()} · Output: ${(job.outputTokens ?? 0).toLocaleString()}`}>
              <Coins className="w-2.5 h-2.5" />
              ${job.costUsd.toFixed(4)} · {((job.inputTokens ?? 0) + (job.outputTokens ?? 0)).toLocaleString()} tok
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

      {/* Terminal output */}
      <div className="flex-1 overflow-hidden flex flex-col min-h-0">
        {/* Indeterminate activity bar — scrolls while running */}
        {isRunning && (
          <div className="h-0.5 w-full bg-zinc-900 flex-shrink-0 overflow-hidden relative">
            <style>{`@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}`}</style>
            <div
              className={`absolute h-full w-1/3 ${isStuck ? "bg-red-500" : isThinking ? "bg-amber-500" : "bg-indigo-500"}`}
              style={{ animation: "slide 2s linear infinite" }}
            />
          </div>
        )}
        <div className="px-4 py-2 border-b border-[#27272a] flex items-center gap-2 flex-shrink-0 bg-[#0d0d0f]">
          <div className="flex gap-1.5">
            <div className={`w-2.5 h-2.5 rounded-full ${isRunning ? (isStuck ? "bg-red-500 animate-pulse" : "bg-green-500 animate-pulse") : "bg-zinc-700"}`} />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
            <div className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
          </div>
          <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase flex-1 text-center">
            Agent Output
          </span>
          {isRunning && isStuck ? (
            <span className="flex items-center gap-1.5 text-[10px] text-red-400">
              <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse flex-shrink-0" />
              no output {silentSecs}s
            </span>
          ) : isRunning && isThinking ? (
            <span className="flex items-center gap-1.5 text-[10px] text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse flex-shrink-0" />
              thinking...
            </span>
          ) : isRunning && activeTool ? (
            <span className="flex items-center gap-1.5 text-[10px] text-cyan-400 max-w-[160px] truncate">
              <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse flex-shrink-0" />
              {activeTool}
            </span>
          ) : isRunning ? (
            <span className="flex items-center gap-1 text-[10px] text-indigo-400">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              live
            </span>
          ) : null}
        </div>

        <div className="flex-1 overflow-y-auto bg-[#080809] p-4 min-h-0">
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
                <span className="inline-block w-2 h-3.5 bg-cyan-400 animate-pulse ml-0.5 align-middle opacity-60" />
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

      {/* Chat thread */}
      {messages && messages.length > 0 && (
        <div className="border-t border-[#27272a] flex-shrink-0 max-h-64 overflow-y-auto bg-[#0a0a0c]">
          <div className="px-4 py-2 border-b border-[#27272a]">
            <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase">
              Chat
            </span>
          </div>
          <div className="p-4 space-y-3">
            {messages.map((msg) => (
              <div key={msg._id} className={`flex gap-2 ${msg.role === "user" ? "flex-row-reverse" : "flex-row"}`}>
                <div className={`text-[10px] font-bold mt-0.5 flex-shrink-0 ${
                  msg.role === "assistant" ? "text-indigo-400" : "text-yellow-400"
                }`}>
                  {msg.role === "assistant" ? "Claude" : "You"}
                </div>
                <div className={`text-xs rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-wrap ${
                  msg.role === "assistant"
                    ? "bg-[#141418] text-zinc-300 border border-[#27272a]"
                    : "bg-yellow-950/40 text-yellow-200 border border-yellow-900/50"
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

      {/* Chat input */}
      {canChat && (
        <div className={`border-t p-3 flex-shrink-0 ${
          isWaiting
            ? "border-yellow-900/50 bg-yellow-950/10"
            : "border-[#27272a] bg-[#0d0d0f]"
        }`}>
          {isWaiting && (
            <p className="text-[10px] text-yellow-500 mb-2 font-medium">
              Claude has a question — reply to continue
            </p>
          )}
          {isRunning && (
            <p className="text-[10px] text-zinc-500 mb-2">
              Message will be delivered when Claude finishes this turn
            </p>
          )}
          {/* Attachment previews */}
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
              className="px-2 py-2 bg-[#111113] border border-[#27272a] rounded-md text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors flex-shrink-0"
              title="Attach files"
            >
              <Paperclip className="w-3.5 h-3.5" />
            </button>
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={isWaiting ? "Reply to Claude..." : isRunning ? "Queue a message..." : "Message Claude..."}
              className={`flex-1 bg-[#111113] border rounded-md px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none transition-colors ${
                isWaiting ? "border-yellow-700/60 focus:border-yellow-600" : "border-[#27272a] focus:border-indigo-700"
              }`}
              autoFocus={isWaiting}
            />
            <button
              type="submit"
              disabled={(!reply.trim() && !attachedFiles.length) || sending}
              className={`px-3 py-2 disabled:opacity-40 rounded-md text-xs font-medium flex items-center gap-1 transition-colors ${
                isWaiting
                  ? "bg-yellow-600 hover:bg-yellow-500 text-black"
                  : "bg-indigo-700 hover:bg-indigo-600 text-white"
              }`}
            >
              <Send className="w-3 h-3" />
              {sending ? "…" : "Send"}
            </button>
          </form>
        </div>
      )}

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
