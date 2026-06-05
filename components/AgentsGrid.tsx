"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { GitBranch, Clock, ExternalLink, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type LineType = "tool" | "bash" | "stderr" | "factory" | "error" | "text";

function parseAgentLine(raw: string): { type: LineType; text: string } {
  if (raw.startsWith("\x00tool\x00")) return { type: "tool", text: raw.slice(7) };
  if (raw.startsWith("\x00bash\x00")) return { type: "bash", text: raw.slice(7) };
  if (raw.startsWith("\x00stderr\x00")) return { type: "stderr", text: raw.slice(9) };
  if (raw.startsWith("[factory]")) return { type: "factory", text: raw };
  if (/ERROR|FATAL/.test(raw)) return { type: "error", text: raw };
  return { type: "text", text: raw };
}

function agentLineClass(type: LineType): string {
  switch (type) {
    case "tool":    return "text-cyan-400";
    case "bash":    return "text-amber-300";
    case "stderr":  return "text-zinc-700";
    case "factory": return "text-indigo-400";
    case "error":   return "text-red-400";
    case "text":    return "text-zinc-300";
  }
}

interface MiniTerminalProps {
  jobId: Id<"jobs">;
  isRunning: boolean;
}

function MiniTerminal({ jobId, isRunning }: MiniTerminalProps) {
  const chunks = useQuery(api.jobs.getOutput, { jobId });
  const bottomRef = useRef<HTMLDivElement>(null);
  const output = chunks?.map((c) => c.text).join("") ?? "";

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  return (
    <div className="flex-1 overflow-y-auto bg-[#100c0a] p-3 min-h-0 font-mono text-[10px]">
      {output ? (
        <pre className="whitespace-pre-wrap leading-relaxed">
          {output.split("\n").map((raw, i) => {
            if (!raw) return <span key={i}>{"\n"}</span>;
            const { type, text } = parseAgentLine(raw);
            return (
              <span key={i} className={agentLineClass(type)}>{text}{"\n"}</span>
            );
          })}
          {isRunning && (
            <span className="inline-block w-1.5 h-3 bg-cyan-400 animate-pulse ml-0.5 align-middle opacity-60" />
          )}
        </pre>
      ) : (
        <p className="text-zinc-700 italic">
          {isRunning ? "Starting…" : "No output"}
        </p>
      )}
      <div ref={bottomRef} />
    </div>
  );
}

interface AgentCardProps {
  jobId: Id<"jobs">;
  projectName?: string;
  projectColor?: string;
}

function AgentCard({ jobId, projectName, projectColor }: AgentCardProps) {
  const job = useQuery(api.jobs.get, { id: jobId });
  const cancel = useMutation(api.jobs.cancel);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const isRunning = job?.status === "running";

  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  if (!job) return null;

  // Agents that are mid-flight can be cut; finished ones cannot.
  const canStop = job.status === "running" || job.status === "queued";

  async function handleStop() {
    if (stopping) return;
    setStopping(true);
    try {
      await cancel({ id: jobId });
      toast.success("Agent stopped");
    } catch {
      toast.error("Failed to stop agent");
      setStopping(false);
    }
  }

  const elapsed = job.startedAt
    ? Math.round(((isRunning ? now : (job.completedAt ?? now)) - job.startedAt) / 1000)
    : null;

  return (
    <div className="flex flex-col bg-[#181310] border border-[#2e2722] rounded-lg overflow-hidden" style={{ height: 320 }}>
      {isRunning && (
        <div className="h-0.5 w-full bg-zinc-900 overflow-hidden relative flex-shrink-0">
          <style>{`@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}`}</style>
          <div className="absolute h-full w-1/3 bg-indigo-500" style={{ animation: "slide 2s linear infinite" }} />
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[#2e2722] flex-shrink-0">
        <div className="flex gap-1.5">
          <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-green-500 animate-pulse" : job.status === "completed" ? "bg-green-700" : "bg-red-700"}`} />
          <div className="w-2 h-2 rounded-full bg-zinc-700" />
          <div className="w-2 h-2 rounded-full bg-zinc-700" />
        </div>
        <div className="flex-1 mx-2 min-w-0">
          <span className="text-[10px] text-zinc-500 truncate block">{job.title}</span>
          {projectName && (
            <span
              className="text-[9px] px-1 rounded"
              style={{ color: projectColor ?? "#b86a39" }}
            >
              {projectName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {elapsed !== null && (
            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
              <Clock className="w-2.5 h-2.5" />{elapsed}s
            </span>
          )}
          {canStop && (
            <button
              onClick={handleStop}
              disabled={stopping}
              title="Stop this agent"
              className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-red-950/40 border border-red-900/50 text-red-300 hover:text-red-200 hover:border-red-700 disabled:opacity-40 transition-colors"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <StatusBadge status={job.status} />
        </div>
      </div>

      {(job.branch || job.prUrl) && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-[#241e1a] flex-shrink-0">
          {job.branch && (
            <span className="flex items-center gap-1 text-[10px] text-zinc-600">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch}
            </span>
          )}
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300">
              <ExternalLink className="w-2.5 h-2.5" />PR #{job.prNumber}
            </a>
          )}
        </div>
      )}

      <MiniTerminal jobId={jobId} isRunning={isRunning} />

      {job.error && (
        <div className="px-3 py-2 border-t border-red-900/50 bg-red-950/20 flex-shrink-0">
          <p className="text-[10px] text-red-300 font-mono truncate">{job.error}</p>
        </div>
      )}
    </div>
  );
}

interface Props {
  projectId?: Id<"projects">;
}

type AgentFilter = "all" | "running" | "done" | "failed" | "cancelled";

const FILTERS: { key: AgentFilter; label: string; statuses: string[] }[] = [
  { key: "all",       label: "All",       statuses: [] },
  { key: "running",   label: "Running",   statuses: ["running", "queued", "waiting_for_input"] },
  { key: "done",      label: "Done",      statuses: ["completed"] },
  { key: "failed",    label: "Failed",    statuses: ["failed"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

export function AgentsGrid({ projectId }: Props) {
  const jobs = useQuery(api.jobs.list, projectId ? { projectId } : {}) ?? [];
  const projects = useQuery(api.projects.list, {}) ?? [];
  const projectMap = Object.fromEntries(projects.map((p) => [p._id, p]));
  const [filter, setFilter] = useState<AgentFilter>("all");

  const isActive = (s: string) => s === "running" || s === "queued" || s === "waiting_for_input";

  // Active agents float to the top; finished ones sort by most-recently completed.
  const sortedJobs = [...jobs].sort((a, b) => {
    const aActive = isActive(a.status);
    const bActive = isActive(b.status);
    if (aActive !== bActive) return aActive ? -1 : 1;
    return (b.completedAt ?? b._creationTime) - (a.completedAt ?? a._creationTime);
  });

  const counts = Object.fromEntries(
    FILTERS.map((f) => [
      f.key,
      f.key === "all" ? jobs.length : jobs.filter((j) => f.statuses.includes(j.status)).length,
    ])
  ) as Record<AgentFilter, number>;

  const activeFilter = FILTERS.find((f) => f.key === filter)!;
  const displayJobs =
    filter === "all"
      ? sortedJobs
      : sortedJobs.filter((j) => activeFilter.statuses.includes(j.status));

  const showProjectTag = !projectId;

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap items-center gap-1.5 mb-4 flex-shrink-0">
        {FILTERS.map((f) => {
          const selected = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[11px] font-medium border transition-colors ${
                selected
                  ? "bg-indigo-950 border-indigo-700 text-indigo-300"
                  : "bg-[#0d0d0f] border-[#27272a] text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
              }`}
            >
              {f.label}
              <span className={`text-[9px] tabular-nums ${selected ? "text-indigo-400" : "text-zinc-600"}`}>
                {counts[f.key]}
              </span>
            </button>
          );
        })}
      </div>

      {displayJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center">
          <div className="w-12 h-12 rounded-full border border-zinc-800 flex items-center justify-center">
            <span className="text-xl">⚡</span>
          </div>
          <p className="text-sm text-zinc-500">
            {filter === "all" ? "No agents running" : `No ${activeFilter.label.toLowerCase()} agents`}
          </p>
          {filter === "all" && (
            <p className="text-xs text-zinc-700">Queue some jobs and click Run All to start parallel execution</p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <div className="flex flex-col gap-3">
            {displayJobs.map((j) => {
              const p = projectMap[j.projectId];
              return (
                <AgentCard
                  key={j._id}
                  jobId={j._id}
                  projectName={showProjectTag ? p?.name : undefined}
                  projectColor={showProjectTag ? p?.color : undefined}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
