import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface TurnResult {
  assistantText: string;
  resultText: string;
}

export interface ClaudeSession {
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
 * Creates a long-running Claude Code session.
 * Chunks emitted by onChunk are prefixed with \x00tool\x00 or \x00bash\x00 for tool calls,
 * so the UI can colour them differently. Plain text has no prefix.
 */
export function createClaudeSession(cwd: string): ClaudeSession {
  const proc = spawn(
    "claude",
    ["--output-format", "stream-json", "--verbose", "--dangerously-skip-permissions"],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      shell: isWin,
    }
  );

  let buffer = "";
  let chunkHandler: ((text: string) => void) | null = null;
  let sessionIdHandler: ((id: string) => void) | null = null;
  let turnResolve: ((result: TurnResult) => void) | null = null;
  let turnReject: ((err: Error) => void) | null = null;
  let assistantText = "";
  let resultText = "";
  let needsNewline = false; // track if last text chunk ended without \n

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        if (parsed.session_id && sessionIdHandler) {
          sessionIdHandler(parsed.session_id);
        }

        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
              chunkHandler?.(block.text);
              needsNewline = !block.text.endsWith("\n");
            } else if (block.type === "tool_use") {
              // Ensure tool lines start on their own line
              const prefix = needsNewline ? "\n" : "";
              const toolLine = formatToolUse(block.name, block.input ?? {});
              chunkHandler?.(prefix + toolLine);
              needsNewline = false;
            }
          }
        } else if (parsed.type === "result") {
          resultText = parsed.result ?? "";
          // Turn complete — resolve the promise
          const resolve = turnResolve;
          turnResolve = null;
          turnReject = null;
          needsNewline = false;
          if (resolve) {
            const r = { assistantText, resultText };
            assistantText = "";
            resultText = "";
            Promise.resolve(resolve(r)).catch(() => {});
          }
        }
      } catch {
        // Non-JSON startup noise — pass through as plain text
        if (chunkHandler) chunkHandler(line + "\n");
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    // stderr often has progress info — prefix so UI can dim it
    if (chunkHandler) chunkHandler("\x00stderr\x00" + chunk.toString());
  });

  proc.on("close", (code) => {
    if (turnReject && code !== 0) {
      turnReject(new Error(`Claude process exited with code ${code}`));
      turnResolve = null;
      turnReject = null;
    }
  });

  return {
    sendMessage(text: string): Promise<TurnResult> {
      assistantText = "";
      resultText = "";
      needsNewline = false;
      return new Promise((resolve, reject) => {
        turnResolve = resolve;
        turnReject = reject;
        proc.stdin!.write(text + "\n");
      });
    },

    onChunk(fn) { chunkHandler = fn; },
    onSessionId(fn) { sessionIdHandler = fn; },
    cancel() { proc.kill("SIGTERM"); },
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
