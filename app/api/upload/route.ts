import { NextRequest, NextResponse } from "next/server";
import { buildDataUrl, inferMime, MAX_ATTACHMENT_BYTES } from "@/lib/attachments";

// Returns base64 data URLs — attachments are stored in Convex directly (no disk
// needed). Works for any file type: images, Markdown, PDFs, text, etc. The
// original filename is preserved for non-image files (see buildDataUrl).
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("files") as File[];

  const results: string[] = [];
  const skipped: string[] = [];

  await Promise.all(
    files.map(async (file) => {
      const buffer = await file.arrayBuffer();
      if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        skipped.push(file.name);
        return;
      }
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = inferMime(file.name, file.type);
      results.push(buildDataUrl(mimeType, base64, file.name));
    })
  );

  // Key kept as `images` for backward compatibility with existing callers.
  return NextResponse.json({ images: results, skipped });
}
