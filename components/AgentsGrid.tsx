"use client";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { GitBranch, Clock, ExternalLink, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const SSE_BASE = process.env.NEXT_PUBLIC_WORKER_SSE_URL ?? "http://localhost:3099";

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
  // The mini-terminal keeps a dark ink slab, so these use explicit light colours
  // (not the inverted zinc ramp, which would render dark-on-dark).
  switch (type) {
    case "tool":    return "text-cyan-400";
    case "bash":    return "text-amber-300";
    case "stderr":  return "text-[#6b8a6b]";
    case "factory": return "text-[#3bd16f]";
    case "error":   return "text-red-400";
    case "text":    return "text-[#cfe8cf]";
  }
}

interface MiniTerminalProps {
  jobId: Id<"jobs">;
  isRunning: boolean;
}

function MiniTerminal({ jobId, isRunning }: MiniTerminalProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [output, setOutput] = useState("");

  // Output is streamed live over SSE only and never stored, so a mini-terminal
  // shows output only while its job is actively running. When the job isn't
  // running there is nothing to show.
  useEffect(() => {
    if (!isRunning) { setOutput(""); return; }
    let acc = "";
    const es = new EventSource(`${SSE_BASE}/stream/${encodeURIComponent(jobId)}`);
    es.onmessage = (e) => {
      try {
        const { text } = JSON.parse(e.data) as { text: string };
        acc += text;
        setOutput(acc);
      } catch { /* ignore malformed events */ }
    };
    es.onerror = () => es.close();
    return () => es.close();
  }, [jobId, isRunning]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [output]);

  return (
    <div className="flex-1 overflow-y-auto bg-ink p-3 min-h-0 font-mono text-[10px]">
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
            <span className="inline-block w-1.5 h-3 bg-[#3bd16f] animate-pulse ml-0.5 align-middle opacity-60" />
          )}
        </pre>
      ) : (
        <p className="text-[#6b8a6b] italic">
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
    <div className="flex flex-col bg-ink border-[3px] border-ink brutal-shadow-sm overflow-hidden flex-shrink-0" style={{ height: 320, width: 420 }}>
      {isRunning && (
        <div className="h-1 w-full bg-[#2a2722] overflow-hidden relative flex-shrink-0">
          <style>{`@keyframes slide{from{transform:translateX(-100%)}to{transform:translateX(350%)}}`}</style>
          <div className="absolute h-full w-1/3 bg-[#3bd16f]" style={{ animation: "slide 2s linear infinite" }} />
        </div>
      )}
      <div className="flex items-center justify-between px-3 py-2 border-b-[3px] border-ink bg-concrete flex-shrink-0">
        <div className="flex-1 mr-2 min-w-0">
          <span className="text-[11px] font-bold uppercase text-ink truncate block leading-tight">{job.title}</span>
          {projectName && (
            <span
              className="font-data text-[9px] uppercase"
              style={{ color: projectColor ?? "#6b675f" }}
            >
              {projectName}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {elapsed !== null && (
            <span className="flex items-center gap-1 font-data text-[10px] text-muted">
              <Clock className="w-2.5 h-2.5" />{elapsed}s
            </span>
          )}
          {canStop && (
            <button
              onClick={handleStop}
              disabled={stopping}
              title="Stop this agent"
              className="flex items-center gap-1 px-1.5 py-0.5 font-data text-[10px] uppercase border-2 border-[#d6210f] text-[#d6210f] hover:bg-[#d6210f] hover:text-concrete disabled:opacity-40 transition-colors"
            >
              <Square className="w-2.5 h-2.5 fill-current" />
              {stopping ? "Stopping…" : "Stop"}
            </button>
          )}
          <StatusBadge status={job.status} />
        </div>
      </div>

      {(job.branch || job.prUrl) && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b-2 border-[#2a2722] bg-ink flex-shrink-0">
          {job.branch && (
            <span className="flex items-center gap-1 font-data text-[10px] text-[#6b8a6b]">
              <GitBranch className="w-2.5 h-2.5" />
              {job.branch}
            </span>
          )}
          {job.prUrl && (
            <a href={job.prUrl} target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1 font-data text-[10px] text-[#cfe8cf] hover:underline">
              <ExternalLink className="w-2.5 h-2.5" />PR #{job.prNumber}
            </a>
          )}
        </div>
      )}

      <MiniTerminal jobId={jobId} isRunning={isRunning} />

      {job.error && (
        <div className="px-3 py-2 border-t-2 border-[#d6210f] bg-[#d6210f]/15 flex-shrink-0">
          <p className="text-[10px] text-[#ff8a7a] font-mono truncate">{job.error}</p>
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
  { key: "running",   label: "Running",   statuses: ["running", "queued"] },
  { key: "done",      label: "Done",      statuses: ["completed"] },
  { key: "failed",    label: "Failed",    statuses: ["failed"] },
  { key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
];

export function AgentsGrid({ projectId }: Props) {
  const jobs = useQuery(api.jobs.list, projectId ? { projectId } : {}) ?? [];
  const projects = useQuery(api.projects.list, {}) ?? [];
  const projectMap = Object.fromEntries(projects.map((p) => [p._id, p]));
  const [filter, setFilter] = useState<AgentFilter>("all");

  const isActive = (s: string) => s === "running" || s === "queued";

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
    <div className="h-full flex flex-col w-full">
      <div className="flex flex-wrap items-center gap-2 mb-5 flex-shrink-0">
        {FILTERS.map((f) => {
          const selected = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1 font-data text-[11px] uppercase border-2 border-ink transition-colors ${
                selected ? "bg-ink text-concrete" : "bg-concrete text-ink hover:bg-concrete-2"
              }`}
            >
              {f.label}
              <span className="tabular-nums">{counts[f.key]}</span>
            </button>
          );
        })}
      </div>

      {displayJobs.length === 0 ? (
        <div className="flex flex-col items-center justify-center flex-1 gap-3 text-center">
          <div className="w-14 h-14 border-[3px] border-ink flex items-center justify-center">
            <span className="text-xl">⚡</span>
          </div>
          <p className="font-display uppercase text-sm text-ink">
            {filter === "all" ? "No agents running" : `No ${activeFilter.label.toLowerCase()} agents`}
          </p>
          {filter === "all" && (
            <p className="font-data text-[11px] uppercase text-muted">Queue some jobs and click Run to start parallel execution</p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-x-auto overflow-y-hidden">
          <div className="flex flex-row gap-3 h-full">
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
