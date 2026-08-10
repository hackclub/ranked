import { NextRequest, NextResponse } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";

// Locked to *.github.io/hackclubranked/<folder>/ so this can't be used as an
// open URL-fetch proxy.
const PAGES_URL_PATTERN =
  /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,38})\.github\.io\/hackclubranked\/[A-Za-z0-9._-]{1,100}\/$/i;

export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  const url = request.nextUrl.searchParams.get("url");
  if (!url || !PAGES_URL_PATTERN.test(url)) {
    return NextResponse.json({ error: "Invalid pages URL." }, { status: 400 });
  }
  try {
    const response = await fetch(url, { method: "GET", redirect: "follow", cache: "no-store" });
    return NextResponse.json({ ready: response.ok });
  } catch {
    return NextResponse.json({ ready: false });
  }
}
