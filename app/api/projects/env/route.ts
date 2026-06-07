import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import fs from "fs";
import path from "path";

const ENV_FILE = ".env";

// Read the project's .env from disk so the UI mirrors the exact file contents.
export async function GET(req: NextRequest) {
  await getServerSession(authOptions);
  const localPath = req.nextUrl.searchParams.get("localPath");

  if (!localPath) return NextResponse.json({ error: "localPath required" }, { status: 400 });
  if (!fs.existsSync(localPath)) {
    return NextResponse.json({ content: "", exists: false, pathMissing: true, file: ENV_FILE });
  }

  const envPath = path.join(localPath, ENV_FILE);
  const exists = fs.existsSync(envPath);
  const content = exists ? fs.readFileSync(envPath, "utf8") : "";

  return NextResponse.json({ content, exists, file: ENV_FILE });
}

// Write the edited contents straight back to the project's .env on disk.
export async function POST(req: NextRequest) {
  await getServerSession(authOptions);
  const { localPath, content } = await req.json();

  if (!localPath) return NextResponse.json({ error: "localPath required" }, { status: 400 });
  if (typeof content !== "string") return NextResponse.json({ error: "content required" }, { status: 400 });
  if (!fs.existsSync(localPath)) return NextResponse.json({ error: "path not found" }, { status: 404 });

  const envPath = path.join(localPath, ENV_FILE);
  // Keep a single trailing newline (POSIX-friendly), but don't add one to an empty file.
  const normalized = content === "" || content.endsWith("\n") ? content : content + "\n";
  fs.writeFileSync(envPath, normalized, "utf8");

  return NextResponse.json({ ok: true, file: ENV_FILE });
}
