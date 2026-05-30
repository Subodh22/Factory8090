import { NextRequest, NextResponse } from "next/server";

// Returns base64 data URL — images are stored in Convex directly (no disk needed)
export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const files = formData.getAll("files") as File[];

  const results = await Promise.all(
    files.map(async (file) => {
      const buffer = await file.arrayBuffer();
      const base64 = Buffer.from(buffer).toString("base64");
      const mimeType = file.type || "image/png";
      return `data:${mimeType};base64,${base64}`;
    })
  );

  return NextResponse.json({ images: results });
}
