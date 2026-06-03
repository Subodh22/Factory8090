"use client";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { GitPullRequest, GitBranch, ExternalLink } from "lucide-react";
import { formatDistanceToNow } from "./time";

interface Props {
  projectId?: Id<"projects">;
  onSelectJob?: (id: Id<"jobs">) => void;
}

export function PRsPanel({ projectId, onSelectJob }: Props) {
  const jobs = useQuery(api.jobs.list, projectId ? { projectId } : {}) ?? [];
  const projects = useQuery(api.projects.list, {}) ?? [];
  const projectMap = Object.fromEntries(projects.map((p) => [p._id, p]));

  const prJobs = jobs
    .filter((j) => j.prUrl)
    .sort((a, b) => (b.completedAt ?? b.createdAt) - (a.completedAt ?? a.createdAt));

  const showProjectTag = !projectId;

  if (prJobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
        <div className="w-12 h-12 rounded-full border border-zinc-800 flex items-center justify-center">
          <GitPullRequest className="w-5 h-5 text-zinc-600" />
        </div>
        <p className="text-sm text-zinc-500">No pull requests yet</p>
        <p className="text-xs text-zinc-700">Finished jobs that change files open a GitHub PR — it&apos;ll show up here</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <p className="text-[10px] font-semibold text-zinc-500 tracking-widest uppercase mb-3">
        {prJobs.length} pull request{prJobs.length !== 1 ? "s" : ""}
      </p>
      <div className="flex flex-col gap-2">
        {prJobs.map((j) => {
          const p = projectMap[j.projectId];
          return (
            <div
              key={j._id}
              onClick={() => onSelectJob?.(j._id)}
              className="group flex items-center gap-3 px-3 py-2.5 bg-[#0d0d0f] border border-[#27272a] rounded-lg hover:border-zinc-700 transition-colors cursor-pointer"
            >
              <GitPullRequest className="w-4 h-4 text-green-500 flex-shrink-0" />

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-zinc-200 truncate">{j.title}</span>
                  {showProjectTag && p && (
                    <span className="text-[9px] flex-shrink-0" style={{ color: p.color ?? "#6366f1" }}>
                      {p.name}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-3 mt-0.5">
                  {j.branch && (
                    <span className="flex items-center gap-1 text-[10px] text-zinc-600 truncate">
                      <GitBranch className="w-2.5 h-2.5 flex-shrink-0" />
                      {j.branch}
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-600 flex-shrink-0">
                    {formatDistanceToNow(j.completedAt ?? j.createdAt)}
                  </span>
                </div>
              </div>

              <a
                href={j.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-1 px-2 py-1 text-[10px] text-indigo-400 hover:text-indigo-300 border border-indigo-900 hover:border-indigo-700 rounded-md flex-shrink-0 transition-colors"
              >
                <ExternalLink className="w-2.5 h-2.5" />
                PR #{j.prNumber}
              </a>
            </div>
          );
        })}
      </div>
    </div>
  );
}
