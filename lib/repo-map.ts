import fs from "fs";
import path from "path";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".next", "dist", "build", "coverage",
  ".worktrees", ".turbo", "out", ".cache", "__pycache__",
]);

const SYMBOL_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go"]);

const TS_RE = /^export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+(\w+)/;
const PY_RE = /^(?:def|class)\s+(\w+)/;
const GO_RE = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/;

function extractSymbols(filePath: string, content: string): string[] {
  const ext = path.extname(filePath);
  const re = [".ts", ".tsx", ".js", ".jsx"].includes(ext) ? TS_RE
    : ext === ".py" ? PY_RE
    : ext === ".go" ? GO_RE
    : null;
  if (!re) return [];

  const symbols: string[] = [];
  for (const line of content.split("\n")) {
    const m = line.match(re);
    if (m) symbols.push(m[1]);
  }
  return symbols;
}

function walk(dir: string, root: string, lines: string[], depth: number) {
  if (depth > 5) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return; }

  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;

    const fullPath = path.join(dir, entry.name);
    const indent = "  ".repeat(depth);

    if (entry.isDirectory()) {
      lines.push(`${indent}${entry.name}/`);
      walk(fullPath, root, lines, depth + 1);
    } else {
      const ext = path.extname(entry.name);
      if (SYMBOL_EXTS.has(ext)) {
        try {
          const stat = fs.statSync(fullPath);
          if (stat.size > 200_000) { lines.push(`${indent}${entry.name}`); continue; }
          const content = fs.readFileSync(fullPath, "utf8");
          const symbols = extractSymbols(fullPath, content);
          const suffix = symbols.length > 0 ? ` — ${symbols.slice(0, 10).join(", ")}` : "";
          lines.push(`${indent}${entry.name}${suffix}`);
        } catch {
          lines.push(`${indent}${entry.name}`);
        }
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
  }
}

export function buildRepoMap(repoPath: string, maxLines = 250): string {
  const lines: string[] = [];
  walk(repoPath, repoPath, lines, 0);
  const truncated = lines.length > maxLines;
  return `## Repo Map\n${lines.slice(0, maxLines).join("\n")}${truncated ? "\n… (truncated)" : ""}\n`;
}
