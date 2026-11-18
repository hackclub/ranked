import { NextRequest, NextResponse } from "next/server";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { publicPageIsLive } from "@/app/lib/safe-fetch";
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
  // Every call makes this server fetch a page on the caller's behalf. The
  // client polls once every five seconds while a deploy is pending; this
  // leaves room for that and little else.
  if (await rateLimited(`pages-status:${session.user.id}`, 30, 60)) return tooManyRequests();
  try {
    return NextResponse.json({ ready: await publicPageIsLive(url) });
  } catch (error) {
    console.error("pages-status check failed for", url, error);
    return NextResponse.json({ ready: false });
  }
}
