import { NextRequest, NextResponse } from "next/server";
import { githubAuthorizationUrl, githubInstallUrl } from "@/app/lib/github";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

function randomValue(bytes = 32) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url"); }

export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return NextResponse.redirect(appUrl("/api/auth/hackclub/start", request));
  const state = randomValue(24);
  const verifier = randomValue(48);
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString("base64url");
  const redirectUri = appUrl("/api/auth/github/callback", request).toString();
  // Authorizing first, then installing only if the callback finds the app
  // isn't installed (`?mode=install`, which it requests on the player's
  // behalf). It's tempting to lead with the installation screen, since
  // that's the only one that grants repository access — but
  // `installations/new` sends an account that already has the app to its
  // existing installation's configure page, and that page issues no
  // authorization code. Leading with it would strand every returning player
  // whose token expired, at the worst possible moment: mid-publish. The
  // authorize URL issues a code for installed and uninstalled accounts
  // alike, so it's the only safe first hop.
  const installing = request.nextUrl.searchParams.get("mode") === "install";
  const response = NextResponse.redirect(
    installing ? githubInstallUrl(state) : githubAuthorizationUrl(state, challenge, redirectUri),
  );
  const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  response.cookies.set("ranked_github_state", state, options);
  response.cookies.set("ranked_github_verifier", verifier, options);
  // The callback has to know which leg issued the code it gets back: only an
  // authorize URL can carry a code_challenge, so only its codes accept a
  // code_verifier on exchange.
  response.cookies.set("ranked_github_flow", installing ? "install" : "authorize", options);
  return response;
}
