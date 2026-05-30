import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";

export interface RunOptions {
  prompt: string;
  cwd: string;
  images?: string[];          // base64 data URLs
  agentRules?: string;
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (err: string) => void;
  signal?: AbortSignal;
}

export function runClaude(opts: RunOptions): () => void {
  const { prompt, cwd, images = [], agentRules, onChunk, onDone, onError, signal } = opts;

  const systemAppend = agentRules
    ? `\n\nProject rules:\n${agentRules}`
    : "";

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

  const args = ["-p", fullPrompt, "--output-format", "stream-json", "--verbose"];
  for (const img of imageFiles) {
    args.push("--image", img);
  }

  const isWin = process.platform === "win32";
  const proc = spawn(isWin ? "claude.cmd" : "claude", args, {
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
        if (parsed.type === "assistant" && parsed.message?.content) {
          for (const block of parsed.message.content) {
            if (block.type === "text") onChunk(block.text);
          }
        } else if (parsed.type === "result" && parsed.result) {
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
      onDone();
    } else {
      onError(`Process exited with code ${code}`);
    }
  });

  if (signal) {
    signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
    });
  }

  return () => proc.kill("SIGTERM");
}
