import { NextRequest, NextResponse } from "next/server";
import { exchangeGitHubCode } from "@/app/lib/github";
import { decryptSession, encryptSession, SESSION_COOKIE, sessionCookieOptions } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const verifier = request.cookies.get("ranked_github_verifier")?.value;
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!code || !state || !verifier || state !== request.cookies.get("ranked_github_state")?.value || !session?.user) return NextResponse.redirect(appUrl("/?github=failed", request));
  try {
    const redirectUri = appUrl("/api/auth/github/callback", request).toString();
    const github = await exchangeGitHubCode(code, verifier, redirectUri);
    const response = NextResponse.redirect(appUrl("/?github=connected", request));
    response.cookies.set(SESSION_COOKIE, await encryptSession({ user: session.user, github }), sessionCookieOptions());
    response.cookies.delete("ranked_github_state");
    response.cookies.delete("ranked_github_verifier");
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.redirect(appUrl("/?github=failed", request));
  }
}
