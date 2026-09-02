import { NextRequest, NextResponse } from "next/server";
import { exchangeGitHubCode, rankedAccessStatus } from "@/app/lib/github";
import { decryptSession, encryptSession, SESSION_COOKIE, sessionCookieOptions } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

const AUTH_COOKIES = ["ranked_github_state", "ranked_github_verifier", "ranked_github_flow"];

// Set for the one hop through the installation screen, so a player who comes
// back from it still uninstalled (they cancelled, or picked no repositories)
// lands in the app with an explanation instead of being volleyed at GitHub
// again.
const INSTALL_PROMPTED_COOKIE = "ranked_github_install_prompted";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const installationId = request.nextUrl.searchParams.get("installation_id");
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  const expectedState = request.cookies.get("ranked_github_state")?.value;
  const verifier = request.cookies.get("ranked_github_verifier")?.value;
  // Anything arriving from an installation that can't be turned into a token
  // right here gets sent through the authorization leg rather than treated as
  // a failure: GitHub only appends a `code` to the post-install redirect when
  // the app has "Request user authorization (OAuth) during installation"
  // enabled, and someone who installed straight from the app's GitHub page
  // never passed through our start route, so has no state to match. They do
  // have an installation now — they just need the token to go with it, and
  // that leg validates its own state and PKCE pair.
  if (installationId && session?.user && (!code || !state || state !== expectedState)) {
    return NextResponse.redirect(appUrl("/api/auth/github/start?mode=authorize", request));
  }
  if (!code || !state || !verifier || state !== expectedState || !session?.user) return NextResponse.redirect(appUrl("/?github=failed", request));
  try {
    const redirectUri = appUrl("/api/auth/github/callback", request).toString();
    // A code from the installation leg was never issued against a
    // code_challenge, so it must be exchanged without a verifier.
    const installFlow = request.cookies.get("ranked_github_flow")?.value !== "authorize";
    const github = await exchangeGitHubCode(code, installFlow ? null : verifier, redirectUri);
    // Being connected is not the same as being publishable — check now, while
    // the player is still in the flow and one click from GitHub, rather than
    // letting them discover it when a finished match won't publish. A failure
    // of the check itself shouldn't block the connection it just made.
    const access = await rankedAccessStatus(github.accessToken, github.login).catch(() => null);
    // Authorizing establishes who they are; installing is what grants access
    // to the repo. Having just done the first, send them straight on to the
    // second rather than reporting a half-finished connection — this is the
    // step the old flow skipped entirely. Going through the start route
    // rather than GitHub directly is what mints the fresh state cookie that
    // leg needs. The other problems aren't a missing step but a decision
    // (create a repo, approve permissions), so those land in the app where
    // onboarding lays out the choice.
    const alreadyPrompted = request.cookies.has(INSTALL_PROMPTED_COOKIE);
    const needsInstall = access?.problem === "not_installed" && !alreadyPrompted;
    const response = NextResponse.redirect(
      needsInstall
        ? appUrl("/api/auth/github/start?mode=install", request)
        : appUrl(`/?github=${access?.problem ?? "connected"}`, request),
    );
    response.cookies.set(SESSION_COOKIE, await encryptSession({ user: session.user, github }), sessionCookieOptions());
    for (const cookie of AUTH_COOKIES) response.cookies.delete(cookie);
    if (needsInstall) {
      response.cookies.set(INSTALL_PROMPTED_COOKIE, "1", {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 600,
      });
    } else if (alreadyPrompted) {
      response.cookies.delete(INSTALL_PROMPTED_COOKIE);
    }
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.redirect(appUrl("/?github=failed", request));
  }
}
