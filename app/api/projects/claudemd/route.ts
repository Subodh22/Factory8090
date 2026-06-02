import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import fs from "fs";
import path from "path";

export async function POST(req: NextRequest) {
  await getServerSession(authOptions);
  const { localPath, projectName, codemapHint, agentRules } = await req.json();

  if (!localPath) return NextResponse.json({ error: "localPath required" }, { status: 400 });
  if (!fs.existsSync(localPath)) return NextResponse.json({ error: "path not found" }, { status: 404 });

  const claudeMdPath = path.join(localPath, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    return NextResponse.json({ ok: true, skipped: true });
  }

  const lines: string[] = [`# ${projectName}`, ""];

  if (codemapHint?.trim()) {
    lines.push("## Project Structure", codemapHint.trim(), "");
  }

  lines.push(
    "## Agent Guidelines",
    "- Read this file before exploring the codebase",
    "- Focus only on files directly relevant to the task",
    "- Do not read entire directories — read one file to understand a pattern, then apply it",
    "- Ignore: node_modules/, dist/, .next/, build/, .git/, *.lock files",
    "",
  );

  if (agentRules?.trim()) {
    lines.push("## Project Rules", agentRules.trim(), "");
  }

  fs.writeFileSync(claudeMdPath, lines.join("\n"), "utf8");
  return NextResponse.json({ ok: true });
}
