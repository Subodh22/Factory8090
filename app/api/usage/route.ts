import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import os from "os";

/**
 * Returns the real Claude subscription usage (session %, reset times, weekly
 * limits) — the same data Claude Code's `/usage` command shows.
 *
 * It reads the OAuth token Claude Code already stores in
 * `~/.claude/.credentials.json` and proxies Anthropic's usage endpoint. The
 * token is refreshed in that file by the CLI itself, so as long as the worker
 * runs `claude`, it stays valid.
 */

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const OAUTH_BETA = "oauth-2025-04-20";

interface Window {
  utilization: number;
  resets_at: string;
}

function readToken(): { token: string; subscriptionType?: string; expiresAt?: number } | null {
  const credPath = path.join(os.homedir(), ".claude", ".credentials.json");
  if (!fs.existsSync(credPath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(credPath, "utf8"));
    const o = raw.claudeAiOauth ?? raw;
    if (!o?.accessToken) return null;
    return {
      token: o.accessToken,
      subscriptionType: o.subscriptionType,
      expiresAt: o.expiresAt,
    };
  } catch {
    return null;
  }
}

export async function GET() {
  const cred = readToken();
  if (!cred) {
    return NextResponse.json(
      { error: "No Claude credentials found. Sign in with the Claude CLI first." },
      { status: 404 },
    );
  }

  if (cred.expiresAt && cred.expiresAt < Date.now()) {
    return NextResponse.json(
      { error: "Claude token expired. Run any `claude` command to refresh it." },
      { status: 401 },
    );
  }

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${cred.token}`,
        "anthropic-beta": OAUTH_BETA,
      },
      cache: "no-store",
    });

    if (!res.ok) {
      const body = await res.text();
      return NextResponse.json(
        { error: `Usage endpoint returned ${res.status}`, detail: body.slice(0, 300) },
        { status: res.status },
      );
    }

    const data = (await res.json()) as Record<string, Window | null>;

    return NextResponse.json({
      subscriptionType: cred.subscriptionType ?? null,
      session: data.five_hour ?? null,
      weekly: data.seven_day ?? null,
      weeklyOpus: data.seven_day_opus ?? null,
      weeklySonnet: data.seven_day_sonnet ?? null,
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to reach Anthropic usage endpoint", detail: String(err) },
      { status: 502 },
    );
  }
}
