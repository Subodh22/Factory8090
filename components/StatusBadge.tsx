import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const config = {
  pending:           { label: "Pending",        className: "bg-zinc-800 text-zinc-400 border-zinc-700" },
  queued:            { label: "Queued",          className: "bg-amber-950 text-amber-400 border-amber-800" },
  running:           { label: "Running",         className: "bg-indigo-950 text-indigo-400 border-indigo-700 animate-pulse" },
  completed:         { label: "Done",            className: "bg-green-950 text-green-400 border-green-800" },
  failed:            { label: "Failed",          className: "bg-red-950 text-red-400 border-red-800" },
  cancelled:         { label: "Cancelled",       className: "bg-zinc-900 text-zinc-600 border-zinc-800" },
  waiting_for_input: { label: "Needs Reply",     className: "bg-yellow-950 text-yellow-400 border-yellow-700 animate-pulse" },
};

export function StatusBadge({ status }: { status: string }) {
  const s = config[status as keyof typeof config] ?? config.pending;
  return (
    <Badge variant="outline" className={cn("text-[10px] font-medium tracking-wide", s.className)}>
      {s.label}
    </Badge>
  );
}
