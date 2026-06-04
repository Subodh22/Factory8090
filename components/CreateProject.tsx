"use client";
import { useState } from "react";
import { useSession } from "next-auth/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Sparkles, Lock, Globe } from "lucide-react";
import { toast } from "sonner";

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

// "My Cool App!" → "my-cool-app" — preview of the GitHub repo slug.
function slugify(s: string) {
  return s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

interface Props {
  onCreated: (projectId: Id<"projects">, jobId: Id<"jobs">) => void;
}

export function CreateProject({ onCreated }: Props) {
  const { data: session } = useSession();
  const create = useMutation(api.projects.create);
  const createJob = useMutation(api.jobs.create);
  const queueJob = useMutation(api.jobs.updateStatus);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(true);
  const [color, setColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState<string | null>(null);

  const slug = slugify(name);
  const canSubmit = !!slug && !!description.trim() && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!session?.accessToken) {
      toast.error("Sign in with GitHub first");
      return;
    }
    if (!slug) {
      toast.error("Enter a project name");
      return;
    }
    if (!description.trim()) {
      toast.error("Describe what you want to build");
      return;
    }

    try {
      // 1. Create the GitHub repo + clone it locally.
      setBusy("Creating GitHub repo…");
      const res = await fetch("/api/projects/create-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: slug, description: description.trim().slice(0, 350), private: isPrivate }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // 2. Register it as a Factory project.
      setBusy("Adding project…");
      const agentRules =
        "Always run tests before pushing.\nUse conventional commits.\nFocus only on files relevant to the task — do not explore the full codebase.";
      const projectId = await create({
        name: name.trim(),
        repo: data.repo,
        localPath: data.localPath,
        defaultBranch: data.defaultBranch,
        githubToken: session.accessToken,
        agentRules,
        color,
      });

      // Seed a CLAUDE.md so the agent has guidance from the first job (non-fatal).
      try {
        await fetch("/api/projects/claudemd", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ localPath: data.localPath, projectName: name.trim(), agentRules }),
        });
      } catch {
        // ignore — project still works without it
      }

      // 3. Queue the initial build job. The local worker picks it up and builds.
      setBusy("Starting build…");
      const prompt = [
        `Build the following project from scratch in this repository (it is currently empty apart from a README):`,
        "",
        description.trim(),
        "",
        "Choose an appropriate tech stack and project structure, scaffold the app, implement an initial working version, and commit your work.",
      ].join("\n");
      const jobId = await createJob({
        projectId,
        title: `Build: ${name.trim()}`.slice(0, 80),
        prompt,
        images: [],
      });
      await queueJob({ id: jobId, status: "queued" });

      toast.success("Repo created — building now");
      setName("");
      setDescription("");
      onCreated(projectId, jobId);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create project");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="max-w-2xl mx-auto pt-4">
      <div className="flex flex-col gap-4 p-5 bg-[#111113] border border-[#27272a] rounded-xl">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-indigo-400" />
          <h2 className="text-sm font-semibold text-zinc-100">Create a new project</h2>
        </div>
        <p className="text-xs text-zinc-500 -mt-2">
          Describe what you want to build. Factory creates a fresh GitHub repo, adds it here, and an
          agent starts building it right away.
        </p>

        {!session?.accessToken && (
          <p className="text-xs text-amber-400 bg-amber-950/40 border border-amber-900/60 rounded-md px-3 py-2">
            Sign in with GitHub (top right) to create repos.
          </p>
        )}

        <form onSubmit={submit} className="flex flex-col gap-4">
          {/* Project name */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Project Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My App"
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
            {slug && (
              <p className="text-[10px] text-zinc-600 mt-1">
                Repo will be created as <span className="text-zinc-400">{slug}</span>
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              What do you want to build?
            </label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder={`e.g. A todo app with a Next.js frontend and a SQLite backend.\nUsers can add, complete, and delete tasks, and filter by status.`}
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100 text-sm resize-none placeholder:text-zinc-700 focus-visible:ring-indigo-700"
            />
          </div>

          {/* Visibility */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Visibility</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setIsPrivate(true)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  isPrivate
                    ? "bg-indigo-950 border-indigo-700 text-indigo-300"
                    : "bg-[#0a0a0b] border-[#27272a] text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Lock className="w-3 h-3" /> Private
              </button>
              <button
                type="button"
                onClick={() => setIsPrivate(false)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border transition-colors ${
                  !isPrivate
                    ? "bg-indigo-950 border-indigo-700 text-indigo-300"
                    : "bg-[#0a0a0b] border-[#27272a] text-zinc-500 hover:text-zinc-300"
                }`}
              >
                <Globe className="w-3 h-3" /> Public
              </button>
            </div>
          </div>

          {/* Color */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Color</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className="w-6 h-6 rounded-full border-2 transition-all"
                  style={{ backgroundColor: c, borderColor: color === c ? "white" : "transparent" }}
                />
              ))}
            </div>
          </div>

          <Button
            type="submit"
            disabled={!canSubmit}
            className="bg-indigo-600 hover:bg-indigo-500 text-white mt-1"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {busy}
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Sparkles className="w-3.5 h-3.5" />
                Create &amp; Build
              </span>
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
