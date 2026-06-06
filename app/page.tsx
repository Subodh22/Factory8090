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
import { TerminalPanel } from "@/components/TerminalPanel";
import { CreateProject } from "@/components/CreateProject";
import { AddProjectModal } from "@/components/AddProjectModal";
import { EnvPanel } from "@/components/EnvPanel";
import { JobNotifications } from "@/components/JobNotifications";
import { QuickChat } from "@/components/QuickChat";
import { UsagePanel, useClaudeUsage, resetLabel } from "@/components/UsagePanel";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, LogOut, Menu, X } from "lucide-react";

function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

/**
 * Token meter, brutalist edition — a hard-bordered slab. Session % comes from
 * the real Claude subscription usage (same data as Claude Code's `/usage`);
 * the token count is today's real total.
 */
function UsagePill({ inputTokens, outputTokens, jobCount }: { inputTokens: number; outputTokens: number; jobCount: number }) {
  const { data } = useClaudeUsage();
  const total = inputTokens + outputTokens;
  const session = data?.session ?? null;
  const pct = session ? Math.min(Math.round(session.utilization), 100) : null;

  const title = session
    ? `Session: ${pct}% used · ${resetLabel(session.resets_at)}\nToday: ${total.toLocaleString()} tokens (${inputTokens.toLocaleString()} in · ${outputTokens.toLocaleString()} out) across ${jobCount} job${jobCount !== 1 ? "s" : ""}`
    : `Today: ${total.toLocaleString()} tokens across ${jobCount} job${jobCount !== 1 ? "s" : ""}`;

  return (
    <div
      className="font-data text-[11px] border-2 border-ink bg-concrete px-2.5 py-1 cursor-default flex items-center gap-2 uppercase"
      title={title}
    >
      <span className="leading-none">{fmtTokens(total)} tokens</span>
      {pct !== null && (
        <>
          <span className="w-px h-3 bg-ink" />
          <span className="leading-none">{pct}%</span>
          <span className="w-16 h-2 bg-paper border border-ink overflow-hidden">
            <span className="block h-full bg-ink transition-all duration-700" style={{ width: `${pct}%` }} />
          </span>
        </>
      )}
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
  // Mobile-only slide-in drawer for the jobs feed (hidden ≥ lg where it's a static column)
  const [feedOpen, setFeedOpen] = useState(false);

  const project = activeProject ? (projects.find((p) => p._id === activeProject) ?? null) : null;
  const projectId = project?._id; // undefined when "All" is selected

  const todayStats = useQuery(api.jobs.getTodayStats, {});

  const allJobs = useQuery(
    api.jobs.list,
    projectId ? { projectId } : {}
  ) ?? [];
  const runningCount = allJobs.filter((j) => j.status === "running" || j.status === "queued").length;

  const TAB_LABELS: Record<string, string> = {
    board: "Kanban Board",
    agents: "Agents",
    "quick-chat": "Chat",
    chat: "New Job",
    create: "Create Project",
    env: "Env",
    terminal: "Terminal",
  };

  return (
    <div className="h-screen flex flex-col bg-transparent text-ink overflow-hidden">
      <JobNotifications />
      {/* ───────── TOP BAR ───────── */}
      <header className="flex items-center gap-4 px-3 sm:px-[22px] h-[62px] border-b-4 border-ink bg-concrete flex-shrink-0">
        {/* Mobile: open the jobs feed drawer */}
        <button
          onClick={() => setFeedOpen(true)}
          className="lg:hidden flex-shrink-0 text-ink hover:opacity-60 transition-opacity"
          title="Show jobs"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="w-[18px] h-[18px] bg-ink inline-block" />
          <span className="font-display uppercase text-[17px] tracking-tight leading-none">Factory</span>
        </div>

        <div className="flex items-center gap-2 min-w-0 flex-1 overflow-x-auto no-scrollbar">
          {/* All projects button */}
          <button
            onClick={() => setActiveProject(null)}
            className={`font-data text-[11px] px-2.5 py-1 border-2 border-ink uppercase flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap transition-colors ${
              activeProject === null ? "bg-ink text-concrete" : "bg-concrete hover:bg-concrete-2"
            }`}
          >
            All
          </button>

          {/* Per-project buttons */}
          {projects.map((p) => (
            <button
              key={p._id}
              onClick={() => setActiveProject(p._id)}
              className={`font-data text-[11px] px-2.5 py-1 border-2 border-ink uppercase flex items-center gap-1.5 flex-shrink-0 whitespace-nowrap transition-colors ${
                p._id === activeProject ? "bg-ink text-concrete" : "bg-concrete hover:bg-concrete-2"
              }`}
            >
              <span
                className="w-[7px] h-[7px] flex-shrink-0"
                style={{ backgroundColor: p.color ?? "#d6210f" }}
              />
              {p.name}
            </button>
          ))}

          <button
            onClick={() => setShowAddProject(true)}
            className="font-data text-[11px] px-2.5 py-1 border-2 border-ink uppercase flex items-center gap-1 flex-shrink-0 whitespace-nowrap bg-concrete hover:bg-ink hover:text-concrete transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add repo
          </button>
        </div>

        <div className="flex items-center gap-2 sm:gap-3 flex-shrink-0">
          {runningCount > 0 && (
            <button
              onClick={() => setTab("agents")}
              className="flex items-center gap-1.5 px-2.5 py-1 font-data text-[11px] bg-ink text-concrete uppercase"
            >
              <span className="w-1.5 h-1.5 bg-concrete animate-pulse" />
              {runningCount} running
            </button>
          )}

          <div className="hidden sm:block">
            <UsagePill
              inputTokens={todayStats?.inputTokens ?? 0}
              outputTokens={todayStats?.outputTokens ?? 0}
              jobCount={todayStats?.jobCount ?? 0}
            />
          </div>

          <span className="hidden lg:inline font-data text-[11px] bg-ink text-concrete px-2.5 py-1 uppercase">
            Claude Code · Local
          </span>

          {session ? (
            <div className="flex items-center gap-2">
              {session.user?.image && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={session.user.image} alt={session.user.name ?? ""} className="w-[30px] h-[30px] border-2 border-ink" />
              )}
              <span className="hidden sm:inline font-data text-[11px] uppercase">{session.user?.name}</span>
              <button
                onClick={() => signOut()}
                className="text-ink hover:opacity-60 transition-opacity"
                title="Sign out"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <button
              onClick={() => signIn("github")}
              className="font-data text-[11px] px-3 py-1.5 bg-ink text-concrete uppercase brutal-press border-2 border-ink"
            >
              Sign in with GitHub
            </button>
          )}
        </div>
      </header>

      {/* ───────── BODY ───────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Feed — static column on desktop, slide-in drawer on mobile */}
        <div className="hidden lg:flex w-[262px] flex-shrink-0 border-r-4 border-ink flex-col overflow-hidden bg-concrete">
          <div className="flex-1 overflow-hidden">
            <MasterFeed projectId={projectId} onSelectJob={setSelectedJob} />
          </div>
          <div className="flex-shrink-0 border-t-4 border-ink p-3">
            <UsagePanel />
          </div>
        </div>

        {/* Mobile feed drawer */}
        {feedOpen && (
          <div className="lg:hidden fixed inset-0 z-40 flex">
            <div
              className="absolute inset-0 bg-ink/40"
              onClick={() => setFeedOpen(false)}
            />
            <div className="relative w-72 max-w-[82vw] bg-concrete border-r-4 border-ink flex flex-col">
              <div className="flex items-center justify-end px-2 h-10 border-b-4 border-ink flex-shrink-0">
                <button
                  onClick={() => setFeedOpen(false)}
                  className="text-ink hover:opacity-60 p-1"
                  title="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                <MasterFeed
                  projectId={projectId}
                  onSelectJob={(id) => { setSelectedJob(id); setFeedOpen(false); }}
                />
              </div>
              <div className="flex-shrink-0 border-t-4 border-ink p-3">
                <UsagePanel />
              </div>
            </div>
          </div>
        )}

        {/* Center */}
        <div className="flex-1 flex flex-col overflow-hidden bg-transparent">
          <div className="border-b-4 border-ink flex-shrink-0 bg-concrete sticky top-0 z-[5]">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="bg-transparent p-0 h-auto gap-0 rounded-none w-full justify-start overflow-x-auto no-scrollbar">
                {["board", "agents", "quick-chat", "chat", "create", "env", "terminal"].map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="font-sans font-bold uppercase text-[13px] tracking-[.3px] px-[22px] py-4 rounded-none border-r-2 border-ink data-[state=active]:bg-ink data-[state=active]:text-concrete data-[state=inactive]:bg-concrete data-[state=inactive]:text-ink hover:data-[state=inactive]:bg-concrete-2 transition-colors flex-shrink-0"
                  >
                    {t === "agents" ? (
                      <span className="flex items-center gap-1.5">
                        Agents
                        {runningCount > 0 && (
                          <span className="w-1.5 h-1.5 bg-current animate-pulse" />
                        )}
                      </span>
                    ) : (
                      TAB_LABELS[t]
                    )}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex-1 overflow-y-auto p-6 sm:p-12">
            {tab === "board" && (
              <KanbanBoard projectId={projectId} onSelectJob={setSelectedJob} />
            )}

            {tab === "agents" && (
              <AgentsGrid projectId={projectId} />
            )}

            {tab === "quick-chat" && project && (
              <div className="h-full max-h-[calc(100vh-200px)]">
                <QuickChat localPath={project.localPath} projectName={project.name} />
              </div>
            )}

            {tab === "quick-chat" && !project && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="font-display uppercase text-sm text-ink">Select a project to chat</p>
                <p className="font-data text-[11px] uppercase text-muted">Choose a repo from the top bar to get started</p>
              </div>
            )}

            {tab === "chat" && projectId && (
              <div className="max-w-[760px] mx-auto">
                <ChatPanel
                  projectId={projectId}
                  onJobCreated={(id) => { setSelectedJob(id); setTab("board"); }}
                />
              </div>
            )}

            {tab === "create" && (
              <CreateProject
                onCreated={(pid, jid) => {
                  setActiveProject(pid);
                  setSelectedJob(jid);
                  setTab("board");
                }}
              />
            )}

            {tab === "chat" && !projectId && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="font-display uppercase text-sm text-ink">Select a project to create a job</p>
                <p className="font-data text-[11px] uppercase text-muted">Choose a repo from the top bar to get started</p>
              </div>
            )}

            {tab === "env" && project && (
              <EnvPanel key={project._id} localPath={project.localPath} projectName={project.name} />
            )}

            {tab === "env" && !project && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="font-display uppercase text-sm text-ink">Select a project to edit its .env</p>
                <p className="font-data text-[11px] uppercase text-muted">Choose a repo from the top bar to get started</p>
              </div>
            )}

            {tab === "terminal" && project && (
              <TerminalPanel project={{ name: project.name, localPath: project.localPath }} />
            )}

            {tab === "terminal" && !project && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="font-display uppercase text-sm text-ink">Select a project to open a terminal</p>
                <p className="font-data text-[11px] uppercase text-muted">The terminal runs commands from the repo&apos;s root directory</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Job detail — full-screen overlay on mobile, side column on desktop */}
        {selectedJob && tab !== "agents" && tab !== "terminal" && (
          <div className="fixed inset-0 z-30 bg-concrete lg:static lg:inset-auto lg:z-auto lg:w-96 flex-shrink-0 border-l-4 border-ink flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b-4 border-ink bg-ink text-concrete">
              <span className="font-display text-[13px] tracking-wide uppercase">
                Job Detail
              </span>
              <button onClick={() => setSelectedJob(null)} className="text-concrete hover:opacity-60 text-sm">
                ✕
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <JobDetail jobId={selectedJob} onRedo={(id) => { setSelectedJob(id); setTab("board"); }} />
            </div>
          </div>
        )}
      </div>

      {showAddProject && <AddProjectModal onClose={() => setShowAddProject(false)} />}
    </div>
  );
}
