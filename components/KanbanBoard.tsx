"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { JobCard } from "./JobCard";
import { ScrollArea } from "@/components/ui/scroll-area";

const COLUMNS = [
  { key: "pending",           label: "Backlog",     dot: "#6b675f" },
  { key: "queued",            label: "Queued",      dot: "#b8860b" },
  { key: "running",           label: "In Progress", dot: "#1f7a3d" },
  { key: "waiting_for_input", label: "Needs Reply", dot: "#d97706" },
  { key: "completed",         label: "Done",        dot: "#1f7a3d" },
  { key: "failed",            label: "Failed",      dot: "#d6210f" },
  { key: "cancelled",         label: "Cancelled",   dot: "#6b675f" },
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
    <div className="w-full h-full border-4 border-ink bg-concrete overflow-hidden flex flex-col brutal-shadow">
      <div className="flex-1 flex overflow-x-auto">
        {COLUMNS.map((col, i) => {
          const colJobs = byStatus[col.key] ?? [];
          return (
            <div
              key={col.key}
              className={`flex-shrink-0 w-[80vw] sm:flex-1 sm:w-auto sm:min-w-[180px] flex flex-col ${i < COLUMNS.length - 1 ? "border-r-4 border-ink" : ""}`}
            >
              <div className="flex items-center justify-between px-4 py-3.5 border-b-4 border-ink bg-ink text-concrete">
                <span className="font-display uppercase text-[13px] flex items-center gap-2">
                  <span className="w-2 h-2" style={{ backgroundColor: col.dot }} />
                  {col.label}
                </span>
                <span className="font-data text-[12px]">{String(colJobs.length).padStart(2, "0")}</span>
              </div>
              <ScrollArea className="flex-1">
                <div className="flex flex-col gap-3.5 p-3.5">
                  {colJobs.map((job) => (
                    <JobCard key={job._id} job={job} onSelect={onSelectJob} />
                  ))}
                  {colJobs.length === 0 && (
                    <div className="border-2 border-dashed border-ink/40 p-6 text-center font-data text-[10px] uppercase text-muted">
                      No {col.label.toLowerCase()} jobs
                    </div>
                  )}
                </div>
              </ScrollArea>
            </div>
          );
        })}
      </div>
    </div>
  );
}
