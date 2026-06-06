import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/route";
import { repoNameAvailable } from "@/lib/github";

// Checks whether a repo name is still free on the signed-in user's account, so
// the UI can warn before the user submits instead of failing on creation.
export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions);
  const token = session?.accessToken ?? process.env.GITHUB_TOKEN;
  if (!token) {
    return NextResponse.json({ error: "Sign in with GitHub" }, { status: 401 });
  }

  const name = new URL(req.url).searchParams.get("name")?.trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  try {
    const available = await repoNameAvailable(token, name);
    return NextResponse.json({ available });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Check failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
