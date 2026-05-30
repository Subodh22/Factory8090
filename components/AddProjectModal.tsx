"use client";
import { useState, useEffect, useRef } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { X, GitBranch, Loader2, Lock, Search, ChevronDown } from "lucide-react";
import { toast } from "sonner";

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6", "#06b6d4"];

type GHRepo = { fullName: string; defaultBranch: string; private: boolean; description: string | null };

export function AddProjectModal({ onClose }: { onClose: () => void }) {
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

  const [tokenInput, setTokenInput] = useState("");
  const [ghRepos, setGhRepos] = useState<GHRepo[]>([]);
  const [filteredRepos, setFilteredRepos] = useState<GHRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
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
    if (!repoSearch) {
      setFilteredRepos(ghRepos);
    } else {
      const q = repoSearch.toLowerCase();
      setFilteredRepos(ghRepos.filter((r) => r.fullName.toLowerCase().includes(q)));
    }
  }, [repoSearch, ghRepos]);

  async function loadRepos() {
    if (!tokenInput) { toast.error("Enter a GitHub token first"); return; }
    setLoadingRepos(true);
    try {
      const res = await fetch(`/api/github/repos?token=${encodeURIComponent(tokenInput)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setGhRepos(data.repos);
      setFilteredRepos(data.repos);
      setShowDropdown(true);
      setForm((f) => ({ ...f, githubToken: tokenInput }));
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
    }));
    setShowDropdown(false);
    setRepoSearch("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name || !form.repo || !form.localPath) {
      toast.error("Name, repo and local path are required");
      return;
    }
    await create(form);
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
          {/* Step 1: GitHub Token + load repos */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              GitHub Token
            </label>
            <div className="flex gap-2">
              <Input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), loadRepos())}
                placeholder="ghp_…"
                className="bg-[#0a0a0b] border-[#27272a] text-zinc-100 flex-1"
              />
              <Button
                type="button"
                onClick={loadRepos}
                disabled={loadingRepos || !tokenInput}
                className="bg-zinc-800 hover:bg-zinc-700 text-zinc-100 px-3 shrink-0"
              >
                {loadingRepos ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <GitBranch className="w-3.5 h-3.5" />
                )}
                <span className="ml-1.5 text-xs">{ghRepos.length ? "Reload" : "Load repos"}</span>
              </Button>
            </div>
            <p className="text-[10px] text-zinc-600 mt-1">
              Needs <code className="text-zinc-500">repo</code> scope.{" "}
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=Factory"
                target="_blank"
                rel="noreferrer"
                className="text-indigo-500 hover:text-indigo-400 underline"
              >
                Create token
              </a>
            </p>
          </div>

          {/* Step 2: Repo picker */}
          <div ref={dropdownRef} className="relative">
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              GitHub Repo
            </label>
            <button
              type="button"
              onClick={() => ghRepos.length && setShowDropdown((v) => !v)}
              className="w-full flex items-center justify-between px-3 py-2 bg-[#0a0a0b] border border-[#27272a] rounded-md text-sm text-left transition-colors hover:border-zinc-600"
            >
              {selectedRepo ? (
                <span className="flex items-center gap-2 text-zinc-100">
                  {selectedRepo.private && <Lock className="w-3 h-3 text-zinc-500 shrink-0" />}
                  {selectedRepo.fullName}
                </span>
              ) : (
                <span className="text-zinc-600">
                  {ghRepos.length ? "Select a repo…" : "Load repos first"}
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
                <div className="max-h-48 overflow-y-auto">
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
          </div>

          {/* Or type manually */}
          {!selectedRepo && (
            <div>
              <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
                Or type repo manually
              </label>
              <Input
                value={form.repo}
                onChange={(e) => setForm({ ...form, repo: e.target.value })}
                placeholder="org/repo"
                className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
              />
            </div>
          )}

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

          {/* Local path + default branch */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              Local Path
            </label>
            <Input
              value={form.localPath}
              onChange={(e) => setForm({ ...form, localPath: e.target.value })}
              placeholder="C:\Users\you\projects\my-app"
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
            <p className="text-[10px] text-zinc-600 mt-1">Where this repo is cloned on this machine</p>
          </div>

          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              Default Branch
            </label>
            <Input
              value={form.defaultBranch}
              onChange={(e) => setForm({ ...form, defaultBranch: e.target.value })}
              className="bg-[#0a0a0b] border-[#27272a] text-zinc-100"
            />
          </div>

          {/* Agent rules */}
          <div>
            <label className="text-[10px] text-zinc-500 uppercase tracking-widest mb-1 block">
              Agent Rules
            </label>
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

          <Button type="submit" className="bg-indigo-600 hover:bg-indigo-500 text-white mt-1">
            Add Project
          </Button>
        </form>
      </div>
    </div>
  );
}
