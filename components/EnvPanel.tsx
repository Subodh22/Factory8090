"use client";
import { useState, useEffect, useCallback } from "react";
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
  const [pathMissing, setPathMissing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/env?localPath=${encodeURIComponent(localPath)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setRows(parseEnv(data.content));
      setOriginal(data.content);
      setExists(data.exists);
      setPathMissing(!!data.pathMissing);
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
      <div className="flex items-center justify-between gap-2 pb-4 mb-4 border-b-4 border-ink flex-shrink-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <code className="font-display uppercase text-lg text-ink">.env</code>
            <span className="font-data text-[10px] uppercase text-muted truncate">{projectName}</span>
            {dirty && <span className="font-data text-[10px] uppercase text-[#b8860b]">● unsaved</span>}
          </div>
          <p className="font-data text-[10px] uppercase text-muted mt-1">
            {loading
              ? "Loading from disk…"
              : pathMissing
                ? `Directory not found: ${localPath}`
                : exists
                  ? `${pairCount} variable${pairCount !== 1 ? "s" : ""} · synced with ${localPath}\\.env`
                  : "No .env yet — saving will create one in the repo root"}
          </p>
        </div>

        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button
            onClick={() => setReveal((v) => !v)}
            title={reveal ? "Hide values" : "Reveal values"}
            className="flex items-center gap-1 px-2 py-1 font-data text-[10px] uppercase text-ink bg-concrete border-2 border-ink hover:bg-ink hover:text-concrete transition-colors"
          >
            {reveal ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
            {reveal ? "Hide" : "Reveal"}
          </button>
          <button
            onClick={() => setRaw((v) => !v)}
            title={raw ? "Structured editor" : "Raw text editor"}
            className="flex items-center gap-1 px-2 py-1 font-data text-[10px] uppercase text-ink bg-concrete border-2 border-ink hover:bg-ink hover:text-concrete transition-colors"
          >
            {raw ? <ListTree className="w-3 h-3" /> : <Braces className="w-3 h-3" />}
            {raw ? "Form" : "Raw"}
          </button>
          <button
            onClick={load}
            disabled={loading}
            title="Reload from disk"
            className="flex items-center gap-1 px-2 py-1 font-data text-[10px] uppercase text-ink bg-concrete border-2 border-ink hover:bg-ink hover:text-concrete transition-colors disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
            Reload
          </button>
          <button
            onClick={save}
            disabled={saving || loading || !dirty}
            className="flex items-center gap-1 px-3 py-1.5 font-data text-[10px] uppercase bg-ink text-concrete border-2 border-ink brutal-press disabled:opacity-40 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-none"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            Save
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted font-data text-xs uppercase">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading .env…
          </div>
        ) : pathMissing ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2 text-center">
            <p className="font-data text-xs uppercase text-[#d6210f]">
              Local path does not exist on disk
            </p>
            <code className="font-mono text-[11px] text-muted break-all px-4">{localPath}</code>
            <p className="font-data text-[10px] uppercase text-muted mt-1">
              Clone the repo or update the project&apos;s local path in settings
            </p>
          </div>
        ) : raw ? (
          <textarea
            value={current}
            onChange={(e) => setRows(parseEnv(e.target.value))}
            spellCheck={false}
            placeholder={"# KEY=value, one per line\nNEXT_PUBLIC_CONVEX_URL=https://…"}
            className="w-full h-full min-h-[300px] bg-paper border-[3px] border-ink p-3 font-mono text-xs text-ink outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] resize-none placeholder:text-muted"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {rows.map((r) =>
              r.kind === "pair" ? (
                <div key={r.id} className="flex items-center gap-1.5 group">
                  <input
                    value={r.key}
                    onChange={(e) => updatePair(r.id, { key: e.target.value })}
                    placeholder="KEY"
                    spellCheck={false}
                    className="w-2/5 bg-paper border-2 border-ink px-2.5 py-1.5 font-mono text-xs font-bold text-ink outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] placeholder:text-muted"
                  />
                  <span className="text-ink text-xs font-bold">=</span>
                  <input
                    value={r.value}
                    onChange={(e) => updatePair(r.id, { value: e.target.value })}
                    placeholder="value"
                    spellCheck={false}
                    type={!reveal && looksSecret(r.key) ? "password" : "text"}
                    className="flex-1 bg-paper border-2 border-ink px-2.5 py-1.5 font-mono text-xs text-ink outline-none focus:shadow-[inset_0_0_0_2px_var(--ink)] placeholder:text-muted"
                  />
                  <button
                    onClick={() => removeRow(r.id)}
                    title="Remove"
                    className="text-muted hover:text-[#d6210f] p-1 opacity-0 group-hover:opacity-100 transition-opacity"
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
                    className="flex-1 bg-transparent border-2 border-transparent px-2.5 py-1 font-mono text-xs text-muted outline-none focus:border-ink focus:bg-paper"
                  />
                  <button
                    onClick={() => removeRow(r.id)}
                    title="Remove"
                    className="text-muted hover:text-[#d6210f] p-1 opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ),
            )}

            <button
              onClick={addPair}
              className="flex items-center gap-1.5 mt-1 px-2.5 py-1.5 font-data text-[11px] uppercase text-ink border-2 border-dashed border-ink hover:bg-ink hover:text-concrete transition-colors w-fit"
            >
              <Plus className="w-3.5 h-3.5" /> Add variable
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
