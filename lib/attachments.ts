// Shared helpers for file attachments encoded as base64 data URLs.
//
// Images keep the plain `data:<mime>;base64,...` form so they still render in
// <img> tags. Every other file type embeds its original filename as a `;name=`
// data-URL parameter so the name survives the round-trip into Claude's worktree
// (a `spec.md` is far more useful to Claude than `attachment.bin`).

// Each attachment is stored as base64 inside a Convex document. Convex caps a
// single document at ~1 MB, so guard against files that would blow that limit.
export const MAX_ATTACHMENT_BYTES = 900_000;

const EXT_MIME: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  log: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  xml: "application/xml",
  html: "text/html",
  pdf: "application/pdf",
  rtf: "application/rtf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

/** Best-effort MIME type: prefer the browser-provided type, else infer from extension. */
export function inferMime(filename: string, provided?: string): string {
  if (provided) return provided;
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] || "application/octet-stream";
}

/** Build a data URL, embedding the original filename for non-image files. */
export function buildDataUrl(mime: string, base64: string, filename: string): string {
  const safeMime = mime || "application/octet-stream";
  if (safeMime.startsWith("image/")) return `data:${safeMime};base64,${base64}`;
  return `data:${safeMime};name=${encodeURIComponent(filename)};base64,${base64}`;
}

export interface ParsedAttachment {
  mime: string;
  /** Original filename, if one was embedded (non-image files). */
  name: string | null;
  base64: string;
  isImage: boolean;
}

/** Parse a data URL produced by buildDataUrl. Returns null if it isn't base64-encoded. */
export function parseDataUrl(dataUrl: string): ParsedAttachment | null {
  const m = dataUrl.match(/^data:([^;,]*)((?:;[^;,]+)*);base64,(.*)$/);
  if (!m) return null;
  const [, rawMime, params, base64] = m;
  const mime = rawMime || "application/octet-stream";
  const nameMatch = params.match(/;name=([^;]+)/);
  let name: string | null = null;
  if (nameMatch) {
    try {
      name = decodeURIComponent(nameMatch[1]);
    } catch {
      name = nameMatch[1];
    }
  }
  return { mime, name, base64, isImage: mime.startsWith("image/") };
}

/** Strip directory components so a crafted filename can't escape the worktree. */
export function safeFilename(name: string): string {
  return name.replace(/[\\/]/g, "_").replace(/^\.+/, "").trim() || "attachment";
}

/** Human-readable label for an attachment chip. */
export function attachmentLabel(dataUrl: string): string {
  const parsed = parseDataUrl(dataUrl);
  if (parsed?.name) return parsed.name;
  const ext = parsed?.mime.split("/")[1] || "file";
  return `attachment.${ext}`;
}
