import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface TurnResult {
  assistantText: string;
  resultText: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ClaudeSession {
  /** Send a message and wait for Claude to finish the turn. Spawns a new process
   *  per call but passes --resume <sessionId> so conversation context is preserved. */
  sendMessage: (text: string) => Promise<TurnResult>;
  onChunk: (fn: (text: string) => void) => void;
  onSessionId: (fn: (id: string) => void) => void;
  cancel: () => void;
}

const isWin = process.platform === "win32";

function formatToolUse(name: string, input: Record<string, unknown>): string {
  const n = name.toLowerCase();
  if (n === "read") {
    return `\x00tool\x00Read    ${input.file_path ?? input.path ?? ""}\n`;
  }
  if (n === "write") {
    const lines = String(input.content ?? "").split("\n").length;
    return `\x00tool\x00Write   ${input.file_path ?? input.path ?? ""} (${lines} lines)\n`;
  }
  if (n === "edit") {
    return `\x00tool\x00Edit    ${input.file_path ?? input.path ?? ""}\n`;
  }
  if (n === "multiedit") {
    const count = Array.isArray(input.edits) ? input.edits.length : "?";
    return `\x00tool\x00Edit    ${count} file(s)\n`;
  }
  if (n === "bash") {
    const cmd = String(input.command ?? "").replace(/\n/g, " ").slice(0, 100);
    return `\x00bash\x00$ ${cmd}\n`;
  }
  if (n === "glob") {
    const loc = input.path ? ` in ${input.path}` : "";
    return `\x00tool\x00Glob    ${input.pattern ?? ""}${loc}\n`;
  }
  if (n === "grep") {
    const loc = input.path ? ` in ${input.path}` : "";
    return `\x00tool\x00Grep    "${input.pattern ?? ""}"${loc}\n`;
  }
  if (n === "todowrite") {
    return `\x00tool\x00Todo    updated\n`;
  }
  if (n === "websearch") {
    return `\x00tool\x00Search  ${input.query ?? ""}\n`;
  }
  if (n === "webfetch") {
    return `\x00tool\x00Fetch   ${input.url ?? ""}\n`;
  }
  if (n === "agent") {
    return `\x00tool\x00Agent   spawning subagent\n`;
  }
  const firstVal = Object.values(input)[0];
  return `\x00tool\x00${name.padEnd(8)}${String(firstVal ?? "").slice(0, 80)}\n`;
}

/**
 * Creates a Claude Code session.
 *
 * Each sendMessage() call spawns a fresh `claude -p` process (non-interactive,
 * so stdin piping works reliably). The session_id captured from the first turn
 * is passed as --resume on every subsequent turn, giving Claude full conversation
 * context without a persistent process.
 *
 * Chunks are prefixed with \x00tool\x00 / \x00bash\x00 / \x00stderr\x00
 * so the UI can colour-code them.
 */
export function createClaudeSession(cwd: string): ClaudeSession {
  let currentSessionId: string | null = null;
  let chunkHandler: ((text: string) => void) | null = null;
  let sessionIdHandler: ((id: string) => void) | null = null;
  let currentProc: ReturnType<typeof spawn> | null = null;
  let cancelled = false;

  function spawnTurn(text: string): Promise<TurnResult> {
    return new Promise((resolve, reject) => {
      if (cancelled) { reject(new Error("Session cancelled")); return; }

      // Write prompt to a temp file to avoid Windows cmd.exe arg length limits
      // and special-character quoting issues
      const tmpPrompt = path.join(os.tmpdir(), `factory-prompt-${Date.now()}.txt`);
      fs.writeFileSync(tmpPrompt, text, "utf8");

      const args: string[] = [
        "--output-format", "stream-json",
        "--verbose",
        "--dangerously-skip-permissions",
        "--print",          // non-interactive: reads prompt from stdin
      ];
      if (currentSessionId) {
        args.push("--resume", currentSessionId);
      }

      const proc = spawn("claude", args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        shell: isWin,
      });
      currentProc = proc;

      // Feed the prompt via stdin then close — -p/--print reads from stdin when
      // no prompt argument is supplied
      proc.stdin!.write(text + "\n");
      proc.stdin!.end();

      // Clean up temp file (fire and forget)
      fs.unlink(tmpPrompt, () => {});

      let buffer = "";
      let assistantText = "";
      let resultText = "";
      let resolved = false;
      let needsNewline = false;
      let inputTokens = 0;
      let outputTokens = 0;
      let costUsd = 0;

      function finish(result: TurnResult) {
        if (resolved) return;
        resolved = true;
        currentProc = null;
        resolve(result);
      }

      proc.stdout!.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);

            if (parsed.session_id) {
              currentSessionId = parsed.session_id;
              sessionIdHandler?.(parsed.session_id);
            }

            if (parsed.type === "assistant" && parsed.message?.content) {
              const usage = parsed.message.usage;
              if (usage) {
                inputTokens = Math.max(inputTokens, usage.input_tokens ?? 0);
                outputTokens += usage.output_tokens ?? 0;
              }
              for (const block of parsed.message.content) {
                if (block.type === "text" && block.text) {
                  assistantText += block.text;
                  chunkHandler?.(block.text);
                  needsNewline = !block.text.endsWith("\n");
                } else if (block.type === "tool_use") {
                  const prefix = needsNewline ? "\n" : "";
                  chunkHandler?.(prefix + formatToolUse(block.name, block.input ?? {}));
                  needsNewline = false;
                }
              }
            } else if (parsed.type === "result") {
              resultText = parsed.result ?? "";
              costUsd = parsed.total_cost_usd ?? 0;
              finish({ assistantText, resultText, inputTokens, outputTokens, costUsd });
            }
          } catch {
            // Non-JSON startup noise — stream as plain text
            if (chunkHandler) chunkHandler(line + "\n");
          }
        }
      });

      proc.stderr!.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        if (chunkHandler) chunkHandler("\x00stderr\x00" + text);
      });

      proc.on("close", (code) => {
        currentProc = null;
        if (!resolved) {
          if (code === 0 || assistantText) {
            finish({ assistantText, resultText, inputTokens, outputTokens, costUsd });
          } else {
            reject(new Error(`Claude exited with code ${code}`));
          }
        }
      });

      proc.on("error", (err) => {
        if (!resolved) reject(err);
      });
    });
  }

  return {
    sendMessage: spawnTurn,
    onChunk(fn) { chunkHandler = fn; },
    onSessionId(fn) { sessionIdHandler = fn; },
    cancel() {
      cancelled = true;
      currentProc?.kill("SIGTERM");
    },
  };
}

/** Write a base64 image to a temp file, return path */
function saveImageFile(dataUrl: string): string | null {
  const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
  if (!matches) return null;
  const [, ext, b64] = matches;
  const tmpPath = path.join(os.tmpdir(), `factory-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
  fs.writeFileSync(tmpPath, Buffer.from(b64, "base64"));
  return tmpPath;
}
