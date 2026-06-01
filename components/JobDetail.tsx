"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { ExternalLink, GitBranch, Clock, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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

export function JobDetail({ jobId }: Props) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const chunks = useQuery(api.jobs.getOutput, { jobId });
  const messages = useQuery(api.jobs.listMessages, { jobId });
  const addMessage = useMutation(api.jobs.addMessage);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const output = chunks?.map((c) => c.text).join("") ?? "";
  const isWaiting = job?.status === "waiting_for_input";
  const isRunning = job?.status === "running";
  const canChat = job?.status !== "pending";

  // Derive the last active tool for the live status pill
  const lines = output.split("\n").filter(Boolean);
  const lastToolLine = [...lines].reverse().find((l) => l.startsWith("\x00tool\x00") || l.startsWith("\x00bash\x00"));
  const activeTool = isRunning && lastToolLine
    ? lastToolLine.startsWith("\x00bash\x00")
      ? lastToolLine.slice(7)
      : lastToolLine.slice(7)
    : null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output, messages]);

  async function handleReply(e: React.FormEvent) {
    e.preventDefault();
    if (!reply.trim() || sending) return;
    setSending(true);
    try {
      await addMessage({ jobId, role: "user", text: reply.trim() });
      setReply("");
    } finally {
      setSending(false);
    }
  }

  if (!job) return <div className="p-6 text-zinc-600 text-sm">Loading…</div>;

  const elapsed = job.startedAt
    ? Math.round(((job.completedAt ?? Date.now()) - job.startedAt) / 1000)
    : null;

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

      {/* Terminal output */}
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
          {isRunning && activeTool ? (
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
          <form onSubmit={handleReply} className="flex gap-2">
            <input
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              placeholder={isWaiting ? "Reply to Claude…" : isRunning ? "Queue a message…" : "Message Claude…"}
              className={`flex-1 bg-[#111113] border rounded-md px-3 py-2 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none transition-colors ${
                isWaiting ? "border-yellow-700/60 focus:border-yellow-600" : "border-[#27272a] focus:border-indigo-700"
              }`}
              autoFocus={isWaiting}
            />
            <button
              type="submit"
              disabled={!reply.trim() || sending}
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
