"use client";

import { useEffect, useState } from "react";

interface HealthResponse {
  status: "healthy" | "degraded";
  checks: Record<string, "ok" | "error">;
}

export default function StatusPage() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/health")
      .then(async (res) => {
        const data = await res.json();
        setHealth(data);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-[var(--background)] flex items-center justify-center p-6">
      <div className="w-full max-w-md border-2 border-[var(--ink)] bg-[var(--card)] shadow-[4px_4px_0_var(--ink)]">
        <div className="border-b-2 border-[var(--ink)] px-5 py-3">
          <h1 className="font-[family-name:var(--font-archivo-black)] text-lg uppercase tracking-wider">
            System Status
          </h1>
        </div>

        <div className="px-5 py-6 space-y-4">
          {loading && (
            <p className="font-[family-name:var(--font-space-mono)] text-sm text-[var(--muted)]">
              Checking...
            </p>
          )}

          {error && (
            <div className="space-y-1">
              <span className="inline-block px-2 py-0.5 text-xs font-bold uppercase bg-[var(--destructive)] text-white">
                Unreachable
              </span>
              <p className="font-[family-name:var(--font-jetbrains)] text-xs text-[var(--muted)]">
                {error}
              </p>
            </div>
          )}

          {health && (
            <>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-block px-2 py-0.5 text-xs font-bold uppercase ${
                    health.status === "healthy"
                      ? "bg-green-700 text-white"
                      : "bg-amber-600 text-white"
                  }`}
                >
                  {health.status}
                </span>
              </div>

              <table className="w-full font-[family-name:var(--font-space-mono)] text-sm">
                <tbody>
                  {Object.entries(health.checks).map(([name, result]) => (
                    <tr key={name} className="border-t border-[var(--grid)]">
                      <td className="py-2 pr-4">{name}</td>
                      <td className="py-2 text-right">
                        <span
                          className={
                            result === "ok"
                              ? "text-green-700 font-bold"
                              : "text-[var(--destructive)] font-bold"
                          }
                        >
                          {result}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
