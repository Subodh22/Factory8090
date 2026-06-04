"use client";
import { useEffect, useRef, useState } from "react";
import { Terminal as TerminalIcon, Trash2, Square, CornerDownLeft } from "lucide-react";

const SSE_BASE = process.env.NEXT_PUBLIC_WORKER_SSE_URL ?? "http://localhost:3099";

const EXIT_MARK = "\x00exit\x00";
const STDERR_MARK = "\x00stderr\x00";

type Entry =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string }
  | { kind: "err"; text: string }
  | { kind: "exit"; code: number }
  | { kind: "info"; text: string };

type TerminalProject = { name: string; localPath: string };

/**
 * Non-interactive terminal: each command is spawned by the worker in the
 * project's localPath, and stdout/stderr stream back over the worker's SSE
 * server. Not a PTY — no vim/arrow-key programs — but enough to run builds,
 * git, npm, tests, etc. from the browser.
 */
export function TerminalPanel({ project }: { project: TerminalProject }) {
  const [entries, setEntries] = useState<Entry[]>([
    { kind: "info", text: `Connected to ${project.localPath}` },
  ]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);

  // Persistent session id for this mounted terminal (one per project switch).
  const sessionIdRef = useRef<string>("");
  if (!sessionIdRef.current) {
    sessionIdRef.current = `term-${Math.random().toString(36).slice(2)}-${project.localPath.length}`;
  }
  const sessionId = sessionIdRef.current;

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Command history (newest last); -1 means "not browsing history".
  const historyRef = useRef<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);

  // Subscribe to this session's output stream.
  useEffect(() => {
    const es = new EventSource(`${SSE_BASE}/stream/${encodeURIComponent(sessionId)}`);
    es.onopen = () => setConnected(true);
    es.onmessage = (e) => {
      let text: string;
      try {
        text = (JSON.parse(e.data) as { text: string }).text;
      } catch {
        return;
      }
      if (text.startsWith(EXIT_MARK)) {
        const code = Number(text.slice(EXIT_MARK.length)) || 0;
        setRunning(false);
        setEntries((prev) => [...prev, { kind: "exit", code }]);
        return;
      }
      if (text.startsWith(STDERR_MARK)) {
        setEntries((prev) => [...prev, { kind: "err", text: text.slice(STDERR_MARK.length) }]);
        return;
      }
      setEntries((prev) => [...prev, { kind: "out", text }]);
    };
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [sessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [entries]);

  async function run() {
    const command = input.trim();
    if (!command || running || !connected) return;

    if (command === "clear" || command === "cls") {
      setEntries([]);
      setInput("");
      return;
    }

    historyRef.current.push(command);
    setHistIdx(-1);
    setEntries((prev) => [...prev, { kind: "cmd", text: command }]);
    setInput("");
    setRunning(true);

    try {
      const res = await fetch(`${SSE_BASE}/terminal/exec`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, cwd: project.localPath, command }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: res.statusText }));
        setEntries((prev) => [...prev, { kind: "err", text: `${error}\n` }]);
        setRunning(false);
      }
    } catch (err) {
      setEntries((prev) => [...prev, { kind: "err", text: `${(err as Error).message}\n` }]);
      setRunning(false);
    }
  }

  async function kill() {
    try {
      await fetch(`${SSE_BASE}/terminal/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
    } catch { /* ignore */ }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
      return;
    }
    if (e.key === "c" && e.ctrlKey && running) {
      e.preventDefault();
      kill();
      return;
    }
    const hist = historyRef.current;
    if (e.key === "ArrowUp" && hist.length) {
      e.preventDefault();
      const next = histIdx === -1 ? hist.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(next);
      setInput(hist[next]);
    }
    if (e.key === "ArrowDown" && histIdx !== -1) {
      e.preventDefault();
      const next = histIdx + 1;
      if (next >= hist.length) {
        setHistIdx(-1);
        setInput("");
      } else {
        setHistIdx(next);
        setInput(hist[next]);
      }
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#0a0a0b] border border-[#27272a] rounded-lg overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 h-9 border-b border-[#27272a] flex-shrink-0">
        <TerminalIcon className="w-3.5 h-3.5 text-indigo-400" />
        <span className="text-xs font-medium text-zinc-300">{project.name}</span>
        <span className="text-[10px] text-zinc-600 truncate max-w-[40%]" title={project.localPath}>
          {project.localPath}
        </span>
        <span
          className={`ml-auto flex items-center gap-1 text-[10px] ${connected ? "text-emerald-400" : "text-zinc-600"}`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${connected ? "bg-emerald-400" : "bg-zinc-600"}`} />
          {connected ? "connected" : "offline"}
        </span>
        {running && (
          <button
            onClick={kill}
            className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-red-400 hover:text-red-300 border border-red-900 rounded transition-colors"
            title="Stop (Ctrl+C)"
          >
            <Square className="w-2.5 h-2.5" /> stop
          </button>
        )}
        <button
          onClick={() => setEntries([])}
          className="flex items-center gap-1 px-2 py-0.5 text-[10px] text-zinc-500 hover:text-zinc-300 border border-zinc-800 rounded transition-colors"
          title="Clear"
        >
          <Trash2 className="w-2.5 h-2.5" /> clear
        </button>
      </div>

      {/* Output */}
      <div
        className="flex-1 overflow-y-auto px-3 py-2 font-mono text-xs leading-relaxed"
        onClick={() => inputRef.current?.focus()}
      >
        {entries.map((e, i) => {
          if (e.kind === "cmd") {
            return (
              <div key={i} className="whitespace-pre-wrap break-words">
                <span className="text-indigo-400">$ </span>
                <span className="text-zinc-100">{e.text}</span>
              </div>
            );
          }
          if (e.kind === "err") {
            return <pre key={i} className="whitespace-pre-wrap break-words text-red-400 font-mono">{e.text}</pre>;
          }
          if (e.kind === "exit") {
            return (
              <div key={i} className={`text-[10px] ${e.code === 0 ? "text-zinc-600" : "text-red-500"}`}>
                [exit {e.code}]
              </div>
            );
          }
          if (e.kind === "info") {
            return <div key={i} className="text-[10px] text-zinc-600">{e.text}</div>;
          }
          return <pre key={i} className="whitespace-pre-wrap break-words text-zinc-300 font-mono">{e.text}</pre>;
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex items-center gap-2 px-3 h-10 border-t border-[#27272a] flex-shrink-0">
        <span className="text-indigo-400 font-mono text-xs">$</span>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!connected}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          placeholder={connected ? (running ? "running… (Ctrl+C to stop)" : "type a command and press Enter") : "connecting to worker…"}
          className="flex-1 bg-transparent outline-none font-mono text-xs text-zinc-100 placeholder:text-zinc-700 disabled:opacity-50"
        />
        <button
          onClick={run}
          disabled={!connected || running || !input.trim()}
          className="flex items-center gap-1 text-zinc-600 hover:text-zinc-300 disabled:opacity-30 disabled:hover:text-zinc-600 transition-colors"
          title="Run (Enter)"
        >
          <CornerDownLeft className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
