"use client";
import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Trash2, Square } from "lucide-react";

interface Message {
  role: "user" | "assistant";
  text: string;
}

type LineType = "tool" | "bash" | "stderr" | "factory" | "text";

function classifyLine(raw: string): { type: LineType; text: string } {
  if (raw.startsWith("\x00tool\x00")) return { type: "tool", text: raw.slice(7) };
  if (raw.startsWith("\x00bash\x00")) return { type: "bash", text: raw.slice(7) };
  if (raw.startsWith("\x00stderr\x00")) return { type: "stderr", text: raw.slice(9) };
  if (raw.startsWith("[factory]")) return { type: "factory", text: raw };
  return { type: "text", text: raw };
}

function lineColor(type: LineType): string {
  switch (type) {
    case "tool": return "text-cyan-400";
    case "bash": return "text-amber-300";
    case "stderr": return "text-[#6b8a6b]";
    case "factory": return "text-[#3bd16f]";
    case "text": return "text-ink";
  }
}

interface Props {
  localPath: string;
  projectName: string;
}

export function QuickChat({ localPath, projectName }: Props) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStreaming(false);
  }, []);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", text }]);
    setStreaming(true);

    // Add a placeholder assistant message we'll stream into
    setMessages((prev) => [...prev, { role: "assistant", text: "" }]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, localPath, sessionId }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const errText = await res.text();
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { role: "assistant", text: `Error: ${errText}` };
          return updated;
        });
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt.type === "text") {
              setMessages((prev) => {
                const updated = [...prev];
                const last = updated[updated.length - 1];
                updated[updated.length - 1] = { ...last, text: last.text + evt.text };
                return updated;
              });
            } else if (evt.type === "sessionId") {
              setSessionId(evt.sessionId);
            }
            // "done" and "error" events — streaming ends naturally
          } catch { /* skip malformed */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          updated[updated.length - 1] = { ...last, text: last.text + `\n\nError: ${err}` };
          return updated;
        });
      }
    } finally {
      abortRef.current = null;
      setStreaming(false);
    }
  }, [input, streaming, localPath, sessionId]);

  function clear() {
    if (streaming) stop();
    setMessages([]);
    setSessionId(null);
  }

  return (
    <div className="flex flex-col h-full max-w-[860px] mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-4 border-ink border-b-0 bg-paper brutal-shadow-sm">
        <div>
          <b className="font-display uppercase text-[15px]">Chat</b>
          <span className="font-data text-[11px] text-muted ml-3 uppercase">{projectName}</span>
          {sessionId && (
            <span className="font-data text-[10px] text-muted ml-2" title={sessionId}>
              (session active)
            </span>
          )}
        </div>
        <button
          onClick={clear}
          className="font-data text-[11px] px-2.5 py-1.5 uppercase flex items-center gap-1.5 border-2 border-ink text-ink hover:bg-ink hover:text-concrete transition-colors"
          title="Clear chat and start fresh"
        >
          <Trash2 className="w-3 h-3" />
          Clear
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto border-4 border-ink border-b-0 bg-concrete p-4 space-y-4 min-h-0">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <p className="font-data text-[11px] text-muted uppercase">
              Chat with Claude about {projectName}. Nothing is saved.
            </p>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[85%] ${msg.role === "user" ? "order-last" : ""}`}>
              <span className="font-data text-[10px] font-bold uppercase text-muted mb-1 block">
                {msg.role === "user" ? "You" : "Claude"}
              </span>
              {msg.role === "assistant" ? (
                <pre className="text-xs font-mono whitespace-pre-wrap leading-relaxed px-4 py-3 border-2 border-ink bg-paper">
                  {msg.text ? msg.text.split("\n").map((raw, j) => {
                    const { type, text } = classifyLine(raw);
                    return (
                      <span key={j} className={lineColor(type)}>
                        {text}{"\n"}
                      </span>
                    );
                  }) : (
                    <span className="inline-block w-2 h-3.5 bg-ink animate-pulse" />
                  )}
                  {streaming && i === messages.length - 1 && msg.text && (
                    <span className="inline-block w-2 h-3.5 bg-ink animate-pulse ml-0.5 align-middle opacity-60" />
                  )}
                </pre>
              ) : (
                <div className="text-xs font-mono whitespace-pre-wrap px-4 py-3 border-2 border-ink bg-ink text-concrete">
                  {msg.text}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-4 border-ink bg-paper p-4 brutal-shadow">
        <div className="flex gap-2">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Message Claude... (Enter to send)"
            disabled={streaming}
            className="flex-1 bg-concrete border-[3px] border-ink px-3.5 py-2.5 font-mono text-[13px] text-ink placeholder:text-muted focus:outline-none focus:bg-[#dfdcd4] focus:shadow-[inset_0_0_0_3px_var(--ink)] transition-shadow disabled:opacity-50"
            autoFocus
          />
          {streaming ? (
            <button
              onClick={stop}
              className="px-4 py-2.5 bg-[#d6210f] text-concrete border-[3px] border-ink font-display uppercase text-[13px] flex items-center gap-2 brutal-press"
            >
              <Square className="w-3.5 h-3.5" />
              Stop
            </button>
          ) : (
            <button
              onClick={send}
              disabled={!input.trim()}
              className="px-4 py-2.5 bg-ink text-concrete border-[3px] border-ink font-display uppercase text-[13px] flex items-center gap-2 brutal-press disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
