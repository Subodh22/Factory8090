"use client";
import { useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { KanbanBoard } from "@/components/KanbanBoard";
import { ChatPanel } from "@/components/ChatPanel";
import { MasterFeed } from "@/components/MasterFeed";
import { JobDetail } from "@/components/JobDetail";
import { AgentsGrid } from "@/components/AgentsGrid";
import { AddProjectModal } from "@/components/AddProjectModal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Factory, LogOut, Zap, LayoutGrid } from "lucide-react";
import { toast } from "sonner";

// Approximate Claude Pro session token cap (~88K tokens per 5-hour window)
const SESSION_TOKEN_CAP = 88_000;

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function UsagePill({ inputTokens, outputTokens, jobCount }: { inputTokens: number; outputTokens: number; jobCount: number }) {
  const total = inputTokens + outputTokens;
  const pct = Math.min((total / SESSION_TOKEN_CAP) * 100, 100);
  const color = pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-400" : "bg-blue-500";

  return (
    <div
      className="flex items-center gap-2 px-3 py-1.5 bg-zinc-900 rounded-full border border-zinc-800 cursor-default"
      title={`Today: ${total.toLocaleString()} tokens (${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out) across ${jobCount} job${jobCount !== 1 ? "s" : ""}`}
    >
      <div className="flex flex-col gap-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-zinc-300 leading-none font-medium">{fmtTokens(total)} tokens</span>
          <span className="text-[10px] text-zinc-500 leading-none">{Math.round(pct)}% used</span>
        </div>
        <div className="w-24 h-1 bg-zinc-800 rounded-full overflow-hidden">
          <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${pct}%` }} />
        </div>
      </div>
    </div>
  );
}

export default function Home() {
  const { data: session } = useSession();
  const projects = useQuery(api.projects.list, {}) ?? [];

  // null = "All projects" view; a project ID = specific project view
  const [activeProject, setActiveProject] = useState<Id<"projects"> | null>(null);
  const [selectedJob, setSelectedJob] = useState<Id<"jobs"> | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [tab, setTab] = useState("board");
  const [runningAll, setRunningAll] = useState(false);

  const project = activeProject ? (projects.find((p) => p._id === activeProject) ?? null) : null;
  const projectId = project?._id; // undefined when "All" is selected

  const todayStats = useQuery(api.jobs.getTodayStats, {});

  const allJobs = useQuery(
    api.jobs.list,
    projectId ? { projectId } : {}
  ) ?? [];
  const runningCount = allJobs.filter((j) => j.status === "running" || j.status === "queued").length;
  const pendingCount = allJobs.filter((j) => j.status === "pending").length;

  async function handleRunAll() {
    if (!projectId) return;
    setRunningAll(true);
    try {
      const res = await fetch("/api/execute/batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json();
      if (data.started > 0) {
        toast.success(`Started ${data.started} agent${data.started !== 1 ? "s" : ""} in parallel`);
        setTab("agents");
      } else {
        toast.info("No pending jobs to run");
      }
    } finally {
      setRunningAll(false);
    }
  }

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0b] text-zinc-100 overflow-hidden">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 h-12 border-b border-[#27272a] flex-shrink-0">
        <div className="flex items-center gap-1">
          <div className="flex items-center gap-2 mr-2">
            <Factory className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold tracking-tight">Factory</span>
          </div>

          <div className="w-px h-4 bg-zinc-800 mr-1" />

          {/* All projects button */}
          <button
            onClick={() => setActiveProject(null)}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
              activeProject === null
                ? "bg-[#1e1e22] text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            <LayoutGrid className="w-3 h-3" />
            All
          </button>

          {/* Per-project buttons */}
          {projects.map((p) => (
            <button
              key={p._id}
              onClick={() => setActiveProject(p._id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                p._id === activeProject
                  ? "bg-[#1e1e22] text-zinc-100"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <span
                className="w-2 h-2 rounded-full flex-shrink-0"
                style={{ backgroundColor: p.color ?? "#6366f1" }}
              />
              {p.name}
            </button>
          ))}

          <button
            onClick={() => setShowAddProject(true)}
            className="flex items-center gap-1 px-2 py-1 text-xs text-zinc-600 hover:text-zinc-300 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add repo
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Run All — only available when a specific project is selected */}
          {projectId && pendingCount > 0 && (
            <button
              onClick={handleRunAll}
              disabled={runningAll}
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-md transition-colors font-medium"
            >
              <Zap className="w-3 h-3" />
              {runningAll ? "Starting…" : `Run All (${pendingCount})`}
            </button>
          )}

          {runningCount > 0 && (
            <button
              onClick={() => setTab("agents")}
              className="flex items-center gap-1.5 px-2.5 py-1 text-[10px] bg-zinc-900 text-indigo-400 rounded-full border border-indigo-900 hover:border-indigo-700 transition-colors"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
              {runningCount} running
            </button>
          )}

          {todayStats && todayStats.jobCount > 0 && (
            <UsagePill inputTokens={todayStats.inputTokens} outputTokens={todayStats.outputTokens} jobCount={todayStats.jobCount} />
          )}

          <span className="text-[10px] text-zinc-600 px-2 py-1 bg-zinc-900 rounded-full">
            Claude Code · local
          </span>

          {session ? (
            <div className="flex items-center gap-2">
              {session.user?.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt={session.user.name ?? ""} className="w-6 h-6 rounded-full" />
              )}
              <span className="text-xs text-zinc-400">{session.user?.name}</span>
              <button
                onClick={() => signOut()}
                className="text-zinc-600 hover:text-zinc-300 transition-colors"
                title="Sign out"
              >
                <LogOut className="w-3.5 h-3.5" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => signIn("github")}
              className="flex items-center gap-1.5 px-3 py-1 text-xs bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-md transition-colors"
            >
              Sign in with GitHub
            </button>
          )}
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Feed — filtered by active project */}
        <div className="w-64 flex-shrink-0 border-r border-[#27272a] flex flex-col overflow-hidden">
          <MasterFeed projectId={projectId} onSelectJob={setSelectedJob} />
        </div>

        {/* Center */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 pt-3 border-b border-[#27272a] flex-shrink-0">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="bg-transparent p-0 h-auto gap-4">
                {["board", "agents", "chat"].map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="text-xs pb-2.5 px-0 rounded-none border-b-2 data-[state=active]:border-indigo-500 data-[state=active]:text-zinc-100 data-[state=inactive]:border-transparent data-[state=inactive]:text-zinc-500 bg-transparent capitalize"
                  >
                    {t === "board" ? "Kanban Board" :
                     t === "agents" ? (
                       <span className="flex items-center gap-1.5">
                         Agents
                         {runningCount > 0 && (
                           <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-pulse" />
                         )}
                       </span>
                     ) : "New Job"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex-1 overflow-hidden p-4">
            {tab === "board" && (
              <KanbanBoard projectId={projectId} onSelectJob={setSelectedJob} />
            )}

            {tab === "agents" && (
              <AgentsGrid projectId={projectId} />
            )}

            {tab === "chat" && projectId && (
              <div className="max-w-2xl mx-auto pt-4">
                <ChatPanel
                  projectId={projectId}
                  onJobCreated={(id) => { setSelectedJob(id); setTab("board"); }}
                />
                <p className="text-[10px] text-zinc-700 text-center mt-3">
                  Queue multiple jobs then hit Run All to launch parallel agents →
                </p>
              </div>
            )}

            {tab === "chat" && !projectId && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-zinc-500">Select a project to create a job</p>
                <p className="text-xs text-zinc-700">Choose a repo from the top bar to get started</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Job detail */}
        {selectedJob && tab !== "agents" && (
          <div className="w-96 flex-shrink-0 border-l border-[#27272a] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-[#27272a]">
              <span className="text-[10px] font-semibold text-zinc-600 tracking-widest uppercase">
                Job Detail
              </span>
              <button onClick={() => setSelectedJob(null)} className="text-zinc-600 hover:text-zinc-300 text-xs">
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <JobDetail jobId={selectedJob} />
            </div>
          </div>
        )}
      </div>

      {showAddProject && <AddProjectModal onClose={() => setShowAddProject(false)} />}
    </div>
  );
}
