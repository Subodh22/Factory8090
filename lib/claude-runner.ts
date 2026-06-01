import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface RunOptions {
  prompt: string;
  cwd: string;
  images?: string[];
  agentRules?: string;
  resumeSessionId?: string;        // if set, runs --resume <id> instead of fresh -p
  onChunk: (text: string) => void;
  onAssistantText?: (text: string) => void; // only assistant message text, not result summary
  onSessionId?: (id: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
  signal?: AbortSignal;
}

export function runClaude(opts: RunOptions): () => void {
  const { prompt, cwd, images = [], agentRules, resumeSessionId, onChunk, onAssistantText, onSessionId, onDone, onError, signal } = opts;

  const systemAppend = agentRules ? `\n\nProject rules:\n${agentRules}` : "";
  const fullPrompt = prompt + systemAppend;

  const imageFiles: string[] = [];
  for (const dataUrl of images) {
    const matches = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!matches) continue;
    const [, ext, b64] = matches;
    const tmpPath = path.join(os.tmpdir(), `factory-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
    fs.writeFileSync(tmpPath, Buffer.from(b64, "base64"));
    imageFiles.push(tmpPath);
  }

  // Build args: resume existing session or start fresh
  const args: string[] = resumeSessionId
    ? ["--resume", resumeSessionId, "-p", fullPrompt, "--output-format", "stream-json", "--verbose"]
    : ["-p", fullPrompt, "--output-format", "stream-json", "--verbose"];

  for (const img of imageFiles) {
    args.push("--image", img);
  }

  const isWin = process.platform === "win32";
  const proc = spawn("claude", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: isWin,
  });

  let buffer = "";

  proc.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);

        // Capture session_id from any event that has it
        if (parsed.session_id && onSessionId) {
          onSessionId(parsed.session_id);
        }

        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "text") {
              onChunk(block.text);
              onAssistantText?.(block.text);
            }
          }
        } else if (parsed.type === "result" && parsed.result) {
          // result is a metadata summary — send to output display but NOT to assistant text tracker
          onChunk(parsed.result);
        }
      } catch {
        onChunk(line + "\n");
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    onChunk(chunk.toString());
  });

  proc.on("close", (code) => {
    for (const f of imageFiles) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
    if (code === 0) {
      Promise.resolve(onDone()).catch((err) =>
        console.error("[claude-runner] onDone error:", err)
      );
    } else {
      Promise.resolve(onError(`Process exited with code ${code}`)).catch((err) =>
        console.error("[claude-runner] onError error:", err)
      );
    }
  });

  if (signal) {
    signal.addEventListener("abort", () => proc.kill("SIGTERM"));
  }

  return () => proc.kill("SIGTERM");
}
