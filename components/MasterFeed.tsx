"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { StatusBadge } from "./StatusBadge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { formatDistanceToNow } from "./time";

interface Props {
  onSelectJob: (id: Id<"jobs">) => void;
}

export function MasterFeed({ onSelectJob }: Props) {
  const jobs = useQuery(api.jobs.list, {}) ?? [];
  const projects = useQuery(api.projects.list, {}) ?? [];
  const projectMap = Object.fromEntries(projects.map((p) => [p._id, p]));

  const sorted = [...jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-3 border-b border-[#27272a]">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold text-zinc-400 tracking-widest uppercase">
            All Jobs
          </span>
          <div className="flex items-center gap-3 text-[10px] text-zinc-600">
            <span className="text-indigo-400">{jobs.filter((j) => j.status === "running").length} running</span>
            <span className="text-amber-400">{jobs.filter((j) => j.status === "queued" || j.status === "pending").length} queued</span>
            <span className="text-green-400">{jobs.filter((j) => j.status === "completed").length} done</span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="divide-y divide-[#1a1a1e]">
          {sorted.map((job) => {
            const project = projectMap[job.projectId];
            return (
              <button
                key={job._id}
                className="w-full text-left px-4 py-3 hover:bg-[#111113] transition-colors group"
                onClick={() => onSelectJob(job._id)}
              >
                <div className="flex items-center justify-between gap-2 mb-1">
                  <span className="text-sm text-zinc-100 font-medium truncate">{job.title}</span>
                  <StatusBadge status={job.status} />
                </div>
                <div className="flex items-center gap-2 text-[10px] text-zinc-600">
                  {project && (
                    <span
                      className="px-1.5 py-0.5 rounded text-zinc-500"
                      style={{ backgroundColor: project.color ? `${project.color}20` : "#1e1e22" }}
                    >
                      {project.name}
                    </span>
                  )}
                  <span>{formatDistanceToNow(job.createdAt)}</span>
                  {job.status === "running" && job.startedAt && (
                    <span className="text-indigo-500">
                      {Math.round((Date.now() - job.startedAt) / 1000)}s
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {sorted.length === 0 && (
            <div className="p-8 text-center text-xs text-zinc-700">
              No jobs yet — create one from the chat panel
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
