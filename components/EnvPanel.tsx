"use client";
import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import {
  Save,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  RefreshCw,
  Loader2,
  Braces,
  ListTree,
} from "lucide-react";
import { toast } from "sonner";

type Row =
  | { kind: "pair"; id: string; key: string; value: string; exported: boolean }
  | { kind: "raw"; id: string; text: string }; // comments and blank lines, preserved verbatim

let rowSeq = 0;
const nextId = () => `row-${rowSeq++}`;

function parseEnv(text: string): Row[] {
  const lines = text.split("\n");
  // A trailing newline yields a final empty element — drop it so we don't show a phantom row.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();

  return lines.map((line) => {
    const trimmed = line.trim();
    const eq = line.indexOf("=");
    if (trimmed === "" || trimmed.startsWith("#") || eq === -1) {
      return { kind: "raw", id: nextId(), text: line };
    }
    let key = line.slice(0, eq).trim();
    let exported = false;
    if (key.startsWith("export ")) {
      exported = true;
      key = key.slice("export ".length).trim();
    }
    return { kind: "pair", id: nextId(), key, value: line.slice(eq + 1), exported };
  });
}

function serializeEnv(rows: Row[]): string {
  return rows
    .map((r) =>
      r.kind === "raw" ? r.text : `${r.exported ? "export " : ""}${r.key}=${r.value}`,
    )
    .join("\n");
}

const looksSecret = (key: string) =>
  /(secret|token|key|password|passwd|pwd|api|private|credential|auth)/i.test(key);

export function EnvPanel({ localPath, projectName }: { localPath: string; projectName: string }) {
  const [rows, setRows] = useState<Row[]>([]);
  const [original, setOriginal] = useState(""); // last loaded/saved content, for dirty-checking
  const [exists, setExists] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [raw, setRaw] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/env?localPath=${encodeURIComponent(localPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(parseEnv(data.content));
      setOriginal(data.content);
      setExists(data.exists);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to load .env");
    } finally {
      setLoading(false);
    }
  }, [localPath]);

  useEffect(() => {
    load();
  }, [load]);

  const current = serializeEnv(rows);
  const dirty = current !== original;

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/projects/env", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath, content: current }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setOriginal(current);
      setExists(true);
      toast.success("Saved .env");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to save .env");
    } finally {
      setSaving(false);
    }
  }

  function updatePair(id: string, patch: Partial<Extract<Row, { kind: "pair" }>>) {
    setRows((rs) => rs.map((r) => (r.id === id && r.kind === "pair" ? { ...r, ...patch } : r)));
  }
  function updateRaw(id: string, text: string) {
    setRows((rs) => rs.map((r) => (r.id === id && r.kind === "raw" ? { ...r, text } : r)));
  }
  function removeRow(id: string) {
    setRows((rs) => rs.filter((r) => r.id !== id));
  }
  function addPair() {
    setRows((rs) => [...rs, { kind: "pair", id: nextId(), key: "", value: "", exported: false }]);
  }

  const pairCount = rows.filter((r) => r.kind === "pair").length;

  return (
    <div className="h-full flex flex-col max-w-3xl mx-auto w-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 pb-3 flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="text-sm font-semibold text-zinc-100">.env</code>
            <span className="text-[10px] text-zinc-600 truncate">{projectName}</span>
            {dirty && <span className="text-[10px] text-amber-400">● unsaved</span>}
          </div>
          <p className="text-[10px] text-zinc-600 mt-0.5">
            {loading
              ? "Loading from disk…"
              : exists
                ? `${pairCount} variable${pairCount !== 1 ? "s" : ""} · synced with ${localPath}\\.env`
                : "No .env yet — saving will create one in the repo root"}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => setReveal((v) => !v)}
            title={reveal ? "Hide values" : "Reveal values"}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 bg-zinc-900 border border-[#27272a] rounded-md transition-colors"
          >
            {reveal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {reveal ? "Hide" : "Reveal"}
          </button>
          <button
            onClick={() => setRaw((v) => !v)}
            title={raw ? "Structured editor" : "Raw text editor"}
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 bg-zinc-900 border border-[#27272a] rounded-md transition-colors"
          >
            {raw ? <ListTree className="w-3 h-3" /> : <Braces className="w-3 h-3" />}
            {raw ? "Form" : "Raw"}
          </button>
          <button
            onClick={load}
            disabled={loading}
            title="Reload from disk"
            className="flex items-center gap-1 px-2 py-1 text-[10px] text-zinc-400 hover:text-zinc-100 bg-zinc-900 border border-[#27272a] rounded-md transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Reload
          </button>
          <Button
            onClick={save}
            disabled={saving || loading || !dirty}
            className="h-7 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-xs disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            <span className="ml-1">Save</span>
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-zinc-600 text-xs">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading .env…
          </div>
        ) : raw ? (
          <textarea
            value={current}
            onChange={(e) => setRows(parseEnv(e.target.value))}
            spellCheck={false}
            placeholder={"# KEY=value, one per line\nNEXT_PUBLIC_CONVEX_URL=https://…"}
            className="w-full h-full min-h-[300px] bg-[#0a0a0b] border border-[#27272a] rounded-md p-3 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-600 resize-none placeholder:text-zinc-700"
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {rows.map((r) =>
              r.kind === "pair" ? (
                <div key={r.id} className="flex items-center gap-1.5 group">
                  <input
                    value={r.key}
                    onChange={(e) => updatePair(r.id, { key: e.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                    className="w-2/5 bg-[#0a0a0b] border border-[#27272a] rounded-md px-2.5 py-1.5 font-mono text-xs text-indigo-300 outline-none focus:border-zinc-600 placeholder:text-zinc-700"
                  />
                  <span className="text-zinc-600 text-xs">=</span>
                  <input
                    value={r.value}
                    onChange={(e) => updatePair(r.id, { value: e.target.value })}
                    placeholder="value"
                    spellCheck={false}
                    type={!reveal && looksSecret(r.key) ? "password" : "text"}
                    className="flex-1 bg-[#0a0a0b] border border-[#27272a] rounded-md px-2.5 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-zinc-600 placeholder:text-zinc-700"
                  />
                  <button
                    onClick={() => removeRow(r.id)}
                    title="Remove"
                    className="text-zinc-700 hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <div key={r.id} className="flex items-center gap-1.5 group">
                  <input
                    value={r.text}
                    onChange={(e) => updateRaw(r.id, e.target.value)}
                    placeholder="# comment"
                    spellCheck={false}
                    className="flex-1 bg-transparent border border-transparent rounded-md px-2.5 py-1 font-mono text-xs text-zinc-600 outline-none focus:border-[#27272a] focus:bg-[#0a0a0b]"
                  />
                  <button
                    onClick={() => removeRow(r.id)}
                    title="Remove"
                    className="text-zinc-700 hover:text-red-400 p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ),
            )}

            <button
              onClick={addPair}
              className="flex items-center gap-1.5 mt-1 px-2.5 py-1.5 text-xs text-zinc-500 hover:text-zinc-200 border border-dashed border-[#27272a] hover:border-zinc-600 rounded-md transition-colors w-fit"
            >
              <Plus className="w-3.5 h-3.5" /> Add variable
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
