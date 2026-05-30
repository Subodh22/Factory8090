"use client";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { KanbanBoard } from "@/components/KanbanBoard";
import { ChatPanel } from "@/components/ChatPanel";
import { MasterFeed } from "@/components/MasterFeed";
import { JobDetail } from "@/components/JobDetail";
import { AddProjectModal } from "@/components/AddProjectModal";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Plus, Factory } from "lucide-react";

export default function Home() {
  const projects = useQuery(api.projects.list, {}) ?? [];
  const [activeProject, setActiveProject] = useState<Id<"projects"> | null>(null);
  const [selectedJob, setSelectedJob] = useState<Id<"jobs"> | null>(null);
  const [showAddProject, setShowAddProject] = useState(false);
  const [tab, setTab] = useState("board");

  const project = projects.find((p) => p._id === activeProject) ?? projects[0] ?? null;
  const projectId = project?._id ?? null;

  return (
    <div className="h-screen flex flex-col bg-[#0a0a0b] text-zinc-100 overflow-hidden">
      {/* Top Bar */}
      <header className="flex items-center justify-between px-4 h-12 border-b border-[#27272a] flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Factory className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold tracking-tight">Factory</span>
          </div>

          <div className="w-px h-4 bg-zinc-800" />

          {projects.map((p) => (
            <button
              key={p._id}
              onClick={() => setActiveProject(p._id)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors ${
                p._id === projectId
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

        <span className="text-[10px] text-zinc-600 px-2 py-1 bg-zinc-900 rounded-full">
          Claude Code · local
        </span>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Feed */}
        <div className="w-64 flex-shrink-0 border-r border-[#27272a] flex flex-col overflow-hidden">
          <MasterFeed onSelectJob={setSelectedJob} />
        </div>

        {/* Center */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <div className="px-4 pt-3 border-b border-[#27272a] flex-shrink-0">
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="bg-transparent p-0 h-auto gap-4">
                {["board", "chat"].map((t) => (
                  <TabsTrigger
                    key={t}
                    value={t}
                    className="text-xs pb-2.5 px-0 rounded-none border-b-2 data-[state=active]:border-indigo-500 data-[state=active]:text-zinc-100 data-[state=inactive]:border-transparent data-[state=inactive]:text-zinc-500 bg-transparent capitalize"
                  >
                    {t === "board" ? "Kanban Board" : "New Job"}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          </div>

          <div className="flex-1 overflow-hidden p-4">
            {tab === "board" && projectId ? (
              <KanbanBoard projectId={projectId} onSelectJob={setSelectedJob} />
            ) : tab === "board" ? (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <Factory className="w-10 h-10 text-zinc-800" />
                <p className="text-sm text-zinc-600">Add a project to get started</p>
                <button
                  onClick={() => setShowAddProject(true)}
                  className="text-xs text-indigo-400 hover:text-indigo-300 underline underline-offset-2"
                >
                  Add your first repo →
                </button>
              </div>
            ) : null}

            {tab === "chat" && projectId && (
              <div className="max-w-2xl mx-auto pt-4">
                <ChatPanel
                  projectId={projectId}
                  onJobCreated={(id) => { setSelectedJob(id); setTab("board"); }}
                />
              </div>
            )}

            {tab === "chat" && !projectId && (
              <div className="flex flex-col items-center justify-center h-full gap-3">
                <p className="text-sm text-zinc-600">Add a project first</p>
              </div>
            )}
          </div>
        </div>

        {/* Right: Job detail */}
        {selectedJob && (
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
