"use client";
import { useEffect, useRef } from "react";
import { useQuery, useMutation } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";

const HEARTBEAT_MS = 10_000;
const CLIENT_ID_KEY = "factory-client-id";

/** Stable per-browser id, so the worker can tell a tab is open. */
function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

function showToast(title: string, status: "completed" | "failed") {
  if (status === "completed") toast.success("Job completed", { description: title });
  else toast.error("Job failed", { description: title });
}

function showNotification(title: string, status: "completed" | "failed") {
  // Desktop notification when the user granted permission (visible even when the
  // tab is backgrounded); otherwise fall back to an in-app toast.
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    const verb = status === "completed" ? "completed ✓" : "failed ✗";
    try {
      new Notification(`Job ${verb}`, { body: title });
      return;
    } catch {
      /* some browsers throw without a user gesture — fall through to the toast */
    }
  }
  showToast(title, status);
}

/**
 * Invisible component: fires a desktop popup when a job finishes while the tab
 * is open, and sends a heartbeat so the worker emails only when no browser is
 * watching. Renders nothing.
 */
export function JobNotifications() {
  const jobs = useQuery(api.jobs.list, {});
  const heartbeat = useMutation(api.presence.heartbeat);
  // null until the first jobs snapshot is seen, so we don't notify for jobs
  // that were already finished when the page loaded.
  const prevStatus = useRef<Map<string, string> | null>(null);

  // Ask for permission once.
  useEffect(() => {
    if (typeof window === "undefined" || !("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Heartbeat while the tab is open.
  useEffect(() => {
    const id = getClientId();
    const beat = () => heartbeat({ clientId: id }).catch(() => {});
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [heartbeat]);

  // Detect completed/failed transitions.
  useEffect(() => {
    if (!jobs) return;
    const next = new Map(jobs.map((j) => [j._id as string, j.status]));
    const prev = prevStatus.current;
    if (prev === null) {
      prevStatus.current = next;
      return;
    }
    for (const j of jobs) {
      const was = prev.get(j._id as string);
      if (was && was !== j.status && (j.status === "completed" || j.status === "failed")) {
        showNotification(j.title, j.status);
      }
    }
    prevStatus.current = next;
  }, [jobs]);

  return null;
}
