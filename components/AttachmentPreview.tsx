"use client";
import { X, FileText } from "lucide-react";
import { parseDataUrl, attachmentLabel } from "@/lib/attachments";

interface Props {
  src: string;
  onRemove?: () => void;
  size?: number;
}

// Renders a single attachment: image thumbnail for images, a labelled file chip
// (with the original filename) for everything else.
export function AttachmentPreview({ src, onRemove, size = 64 }: Props) {
  const parsed = parseDataUrl(src);
  const dim = { width: size, height: size };
  return (
    <div className="relative group">
      {parsed?.isImage ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" style={dim} className="object-cover border-2 border-ink" />
      ) : (
        <div
          style={dim}
          title={attachmentLabel(src)}
          className="flex flex-col items-center justify-center gap-1 border-2 border-ink bg-paper px-1.5 text-center"
        >
          <FileText className="w-4 h-4 text-ink shrink-0" />
          <span className="font-data text-[9px] leading-tight text-ink truncate w-full">{attachmentLabel(src)}</span>
        </div>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 bg-ink border-2 border-ink p-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <X className="w-2.5 h-2.5 text-concrete" />
        </button>
      )}
    </div>
  );
}
