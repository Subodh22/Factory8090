"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { JobCard } from "./JobCard";
import { ScrollArea } from "@/components/ui/scroll-area";

const COLUMNS = [
  { key: "pending",   label: "Backlog",     color: "text-zinc-400" },
  { key: "queued",    label: "Queued",      color: "text-amber-400" },
  { key: "running",   label: "In Progress", color: "text-indigo-400" },
  { key: "completed", label: "Done",        color: "text-green-400" },
  { key: "failed",    label: "Failed",      color: "text-red-400" },
  { key: "cancelled", label: "Cancelled",   color: "text-zinc-600" },
] as const;

interface Props {
  projectId?: Id<"projects">;
  onSelectJob: (id: Id<"jobs">) => void;
}

export function KanbanBoard({ projectId, onSelectJob }: Props) {
  const jobs = useQuery(api.jobs.list, projectId ? { projectId } : {}) ?? [];

  const byStatus = Object.fromEntries(
    COLUMNS.map((col) => [col.key, jobs.filter((j) => j.status === col.key)])
  );

  return (
    <div className="flex gap-3 h-full overflow-x-auto pb-4">
      {COLUMNS.map((col) => {
        const colJobs = byStatus[col.key] ?? [];
        return (
          <div key={col.key} className="flex-shrink-0 w-72 flex flex-col">
            <div className="flex items-center justify-between mb-3 px-1">
              <span className={`text-xs font-semibold tracking-widest uppercase ${col.color}`}>
                {col.label}
              </span>
              <span className="text-[10px] text-zinc-600 bg-zinc-900 rounded-full px-2 py-0.5">
                {colJobs.length}
              </span>
            </div>
            <ScrollArea className="flex-1">
              <div className="flex flex-col gap-2 pr-2">
                {colJobs.map((job) => (
                  <JobCard key={job._id} job={job} onSelect={onSelectJob} />
                ))}
                {colJobs.length === 0 && (
                  <div className="border border-dashed border-zinc-800 rounded-lg p-6 text-center text-xs text-zinc-700">
                    No {col.label.toLowerCase()} jobs
                  </div>
                )}
              </div>
            </ScrollArea>
          </div>
        );
      })}
    </div>
  );
}
