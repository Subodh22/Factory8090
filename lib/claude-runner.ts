import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface TurnResult {
  assistantText: string;
  resultText: string;
}

export interface ClaudeSession {
  /** Send a message and wait for Claude to finish the turn */
  sendMessage: (text: string) => Promise<TurnResult>;
  /** Stream chunks to a callback during an active turn */
  onChunk: (fn: (text: string) => void) => void;
  /** Called when Claude emits a session_id */
  onSessionId: (fn: (id: string) => void) => void;
  /** Kill the process */
  cancel: () => void;
}

const isWin = process.platform === "win32";

/**
 * Creates a long-running Claude Code session.
 * The process stays alive between turns — call sendMessage() for each user turn.
 * Claude processes stdin line-by-line; each message triggers a full response turn.
 */
export function createClaudeSession(cwd: string, agentRules?: string): ClaudeSession {
  const proc = spawn("claude", ["--output-format", "stream-json", "--verbose"], {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell: isWin,
  });

  let buffer = "";
  let chunkHandler: ((text: string) => void) | null = null;
  let sessionIdHandler: ((id: string) => void) | null = null;
  let turnResolve: ((result: TurnResult) => void) | null = null;
  let turnReject: ((err: Error) => void) | null = null;
  let assistantText = "";
  let resultText = "";

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
            if (block.type === "text") {
              assistantText += block.text;
              chunkHandler?.(block.text);
            }
          }
        } else if (parsed.type === "result") {
          if (parsed.result) {
            resultText = parsed.result;
            chunkHandler?.(parsed.result);
          }
          // Turn is complete — resolve the promise
          const resolve = turnResolve;
          turnResolve = null;
          turnReject = null;
          if (resolve) {
            const result = { assistantText, resultText };
            assistantText = "";
            resultText = "";
            Promise.resolve(resolve(result)).catch(() => {});
          }
        }
      } catch {
        chunkHandler?.(line + "\n");
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    chunkHandler?.(chunk.toString());
  });

  proc.on("close", (code) => {
    if (turnReject && code !== 0) {
      turnReject(new Error(`Claude process exited with code ${code}`));
      turnResolve = null;
      turnReject = null;
    }
  });

  // Prime Claude with agent rules if provided (sent as first message before any user prompt)
  const contextPreamble = agentRules
    ? `Project context:\n${agentRules}\n\nYou are a coding assistant. When given a task, look at the codebase and implement the changes directly.\n`
    : `You are a coding assistant. When given a task, look at the codebase and implement the changes directly.\n`;

  // Write the preamble silently — Claude will acknowledge but we ignore this turn's output
  proc.stdin!.write(contextPreamble + "\n");

  return {
    sendMessage(text: string): Promise<TurnResult> {
      assistantText = "";
      resultText = "";
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
