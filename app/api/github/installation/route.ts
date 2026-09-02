import { NextRequest, NextResponse } from "next/server";
import {
  GitHubCredentialsError,
  githubInstallUrl,
  GITHUB_INSTALLATION_SETTINGS_URL,
  rankedAccessStatus,
  refreshGitHubConnection,
} from "@/app/lib/github";
import {
  decryptSession,
  encryptSession,
  SESSION_COOKIE,
  sessionCookieOptions,
  type GitHubConnection,
} from "@/app/lib/session";

// Lets onboarding (and the publish screen) tell "connected" apart from
// "actually able to publish" before a match is on the line. Onboarding used
// to treat a GitHub connection as the finish line, which is why players could
// complete every step and still have an app with no access to their repo.
export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) {
    return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  }
  if (!session.github) {
    return NextResponse.json({
      connected: false,
      problem: "not_connected",
      missingPermissions: [],
      installUrl: githubInstallUrl(),
      settingsUrl: GITHUB_INSTALLATION_SETTINGS_URL,
    });
  }
  let github: GitHubConnection = session.github;
  try {
    github = await refreshGitHubConnection(session.github);
    const access = await rankedAccessStatus(github.accessToken, github.login);
    const response = NextResponse.json({ connected: true, ...access });
    // The refresh token rotates on use, so a refreshed connection has to be
    // written back or the next request retries with a spent one.
    if (github !== session.github) {
      response.cookies.set(
        SESSION_COOKIE,
        await encryptSession({ user: session.user, github, exp: session.exp }),
        sessionCookieOptions(),
      );
    }
    return response;
  } catch (error) {
    if (error instanceof GitHubCredentialsError) {
      return NextResponse.json({
        connected: false,
        problem: "not_connected",
        missingPermissions: [],
        installUrl: githubInstallUrl(),
        settingsUrl: GITHUB_INSTALLATION_SETTINGS_URL,
      });
    }
    console.error("installation status check failed", error);
    // An unreachable GitHub is not a permission problem — say nothing rather
    // than nagging a player whose setup is fine.
    return NextResponse.json({ connected: true, problem: null, missingPermissions: [], installUrl: githubInstallUrl(), settingsUrl: GITHUB_INSTALLATION_SETTINGS_URL });
  }
}
