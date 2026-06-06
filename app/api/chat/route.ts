import { NextRequest } from "next/server";
import { createClaudeSession } from "@/lib/claude-runner";

/**
 * POST /api/chat — ephemeral chat with Claude CLI.
 *
 * Body: { message: string, localPath: string, sessionId?: string }
 *
 * Streams back newline-delimited JSON events:
 *   { type: "text",       text: "..." }
 *   { type: "sessionId",  sessionId: "..." }
 *   { type: "done",       inputTokens, outputTokens, costUsd }
 *   { type: "error",      error: "..." }
 */
export async function POST(req: NextRequest) {
  const { message, localPath, sessionId } =
    (await req.json()) as {
      message: string;
      localPath: string;
      sessionId?: string;
    };

  if (!message?.trim() || !localPath?.trim()) {
    return new Response(
      JSON.stringify({ type: "error", error: "message and localPath required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const session = createClaudeSession(localPath, sessionId);

      session.onSessionId((id) => {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "sessionId", sessionId: id }) + "\n"),
        );
      });

      session.onChunk((text) => {
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "text", text }) + "\n"),
        );
      });

      session
        .sendMessage(message)
        .then((result) => {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({
                type: "done",
                inputTokens: result.inputTokens,
                outputTokens: result.outputTokens,
                costUsd: result.costUsd,
              }) + "\n",
            ),
          );
          controller.close();
        })
        .catch((err) => {
          controller.enqueue(
            encoder.encode(
              JSON.stringify({ type: "error", error: String(err) }) + "\n",
            ),
          );
          controller.close();
        });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
