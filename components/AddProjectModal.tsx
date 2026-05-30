"use client";
import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { X, Loader2, Lock, Search, ChevronDown, RefreshCw, FolderDown } from "lucide-react";
import { toast } from "sonner";

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

type GHRepo = { fullName: string; defaultBranch: string; private: boolean; description: string | null };

export function AddProjectModal({ onClose }: { onClose: () => void }) {
  const { data: session } = useSession();
  const create = useMutation(api.projects.create);

  const [form, setForm] = useState({
    name: "",
    repo: "",
    localPath: "",
    defaultBranch: "main",
    githubToken: "",
    agentRules: "Always run tests before pushing.\nUse conventional commits.",
    color: COLORS[0],
  });

  const [ghRepos, setGhRepos] = useState<GHRepo[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<GHRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [repoSearch, setRepoSearch] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<GHRepo | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  useEffect(() => {
    const q = repoSearch.toLowerCase();
    setFilteredRepos(q ? ghRepos.filter((r) => r.fullName.toLowerCase().includes(q)) : ghRepos);
  }, [repoSearch, ghRepos]);

  // Auto-load repos when modal opens and session is available
  useEffect(() => {
    if (session?.accessToken && ghRepos.length === 0) {
      loadRepos();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.accessToken]);

  async function loadRepos() {
    setLoadingRepos(true);
    try {
      const res = await fetch("/api/github/repos");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGhRepos(data.repos);
      setFilteredRepos(data.repos);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load repos");
    } finally {
      setLoadingRepos(false);
    }
  }

  function selectRepo(r: GHRepo) {
    setSelectedRepo(r);
    setForm((f) => ({
      ...f,
      repo: r.fullName,
      name: f.name || r.fullName.split("/")[1],
      defaultBranch: r.defaultBranch,
      githubToken: session?.accessToken ?? f.githubToken,
    }));
    setShowDropdown(false);
    setRepoSearch("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.repo) {
      toast.error("Name and repo are required");
      return;
    }

    let localPath = form.localPath;

    if (!localPath) {
      setCloning(true);
      try {
        const res = await fetch("/api/projects/clone", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: form.repo }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        localPath = data.localPath;
        if (data.alreadyExists) {
          toast.info(`Using existing clone at ${localPath}`);
        } else {
          toast.success(`Cloned to ${localPath}`);
        }
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : "Clone failed");
        setCloning(false);
        return;
      } finally {
        setCloning(false);
      }
    }

    await create({ ...form, localPath, githubToken: session?.accessToken ?? form.githubToken });
    toast.success("Project added");
    onClose();
  }

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#111113] border border-[#27272a] rounded-xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-4 border-b border-[#27272a]">
          <h2 className="text-sm font-semibold text-zinc-100">Add Project</h2>
          <button onClick={onClose} className="text-zinc-600 hover:text-zinc-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={submit} className="p-4 flex flex-col gap-3">
          {/* Repo picker */}
          <div ref={dropdownRef} className="relative">
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] text-zinc-500 uppercase tracking-widest">GitHub Repo</label>
              {session?.accessToken && (
                <button
                  type="button"
                  onClick={loadRepos}
                  disabled={loadingRepos}
                  className="text-[10px] text-zinc-600 hover:text-zinc-400 flex items-center gap-1"
                >
                  {loadingRepos ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <RefreshCw className="w-3 h-3" />
                  )}
                  {loadingRepos ? "Loading…" : `${ghRepos.length} repos`}
                </button>
              )}
            </div>

            {session?.accessToken ? (
              <>
                <button
                  type="button"
                  onClick={() => ghRepos.length && setShowDropdown((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-[#0a0a0b] border border-[#27272a] rounded-md text-sm text-left transition-colors hover:border-zinc-600"
                >
                  {loadingRepos ? (
                    <span className="flex items-center gap-2 text-zinc-500">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading your repos…
                    </span>
                  ) : selectedRepo ? (
                    <span className="flex items-center gap-2 text-zinc-100">
                      {selectedRepo.private && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
                      {selectedRepo.fullName}
                    </span>
                  ) : (
                    <span className="text-zinc-500">
                      {ghRepos.length ? "Select a repo…" : "Loading…"}
                    </span>
                  )}
                  <ChevronDown className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                </button>

                {showDropdown && (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[#18181b] border border-[#27272a] rounded-lg shadow-xl z-10 overflow-hidden">
                    <div className="p-2 border-b border-[#27272a]">
                      <div className="flex items-center gap-2 px-2 py-1 bg-[#0a0a0b] rounded-md">
                        <Search className="w-3 h-3 text-zinc-500 shrink-0" />
                        <input
                          autoFocus
                          value={repoSearch}
                          onChange={(e) => setRepoSearch(e.target.value)}
                          placeholder="Filter repos…"
                          className="flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
                        />
                      </div>
                    </div>
                    <div className="max-h-52 overflow-y-auto">
                      {filteredRepos.length === 0 ? (
                        <p className="text-xs text-zinc-600 p-3 text-center">No repos found</p>
                      ) : (
                        filteredRepos.map((r) => (
                          <button
                            key={r.fullName}
                            type="button"
                            onClick={() => selectRepo(r)}
                            className="w-full text-left px-3 py-2 hover:bg-[#27272a] transition-colors"
                          >
                            <div className="flex items-center gap-2">
                              {r.private && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
                              <span className="text-xs text-zinc-100">{r.fullName}</span>
                              <span className="text-[10px] text-zinc-600 ml-auto">{r.defaultBranch}</span>
                            </div>
                            {r.description && (
                              <p className="text-[10px] text-zinc-600 mt-0.5 truncate pl-5">{r.description}</p>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <Input
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder="org/repo"
                className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
              />
            )}
          </div>

          {/* Name */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Name</label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="My App"
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
          </div>

          {/* Local path */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[10px] text-zinc-500 uppercase tracking-widest">
                Local Path <span className="text-zinc-700 normal-case">(optional)</span>
              </label>
              {!form.localPath && selectedRepo && (
                <span className="text-[10px] text-indigo-500 flex items-center gap-1">
                  <FolderDown className="w-3 h-3" /> will auto-clone on add
                </span>
              )}
            </div>
            <Input
              value={form.localPath}
              onChange={(e) => setForm({ ...form, localPath: e.target.value })}
              placeholder={
                selectedRepo
                  ? `Leave empty to auto-clone`
                  : "C:\\Users\\you\\projects\\my-app"
              }
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
            <p className="text-[10px] text-zinc-600 mt-1">
              {form.localPath
                ? "Using this existing local path"
                : "Empty = repo will be cloned automatically into your workspace"}
            </p>
          </div>

          {/* Default branch */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Default Branch</label>
            <Input
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
          </div>

          {/* Agent rules */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Agent Rules</label>
            <Textarea
              value={form.agentRules}
              onChange={(e) => setForm({ ...form, agentRules: e.target.value })}
              rows={3}
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100 text-xs resize-none"
            />
          </div>

          {/* Color */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">Color</label>
            <div className="flex gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm({ ...form, color: c })}
                  className="w-6 h-6 rounded-full border-2 transition-all"
                  style={{ backgroundColor: c, borderColor: form.color === c ? "white" : "transparent" }}
                />
              ))}
            </div>
          </div>

          <Button type="submit" disabled={cloning} className="bg-indigo-600 hover:bg-indigo-500 text-white mt-1">
            {cloning ? (
              <span className="flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                Cloning repo…
              </span>
            ) : (
              "Add Project"
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
