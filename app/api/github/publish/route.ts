import { NextRequest, NextResponse } from "next/server";
import { publishWebsite, PUBLISHABLE_FILE_NAME, GitHubCredentialsError, GitHubPermissionError, GitHubRepoNotAccessibleError, refreshGitHubConnection, type DirectoryBuild } from "@/app/lib/github";
import { decryptSession, encryptSession, SESSION_COOKIE, sessionCookieOptions, type GitHubConnection } from "@/app/lib/session";
import { logAudit } from "@/app/lib/audit";
import {
  completeSubmissionProfile,
  getHackClubProfile,
  resolvePrimaryAddress,
} from "@/app/lib/hack-club-profile";
import { addChallengeProgress } from "@/app/lib/progression";
import { getSql } from "@/db";

function validFileMap(value: unknown, maxEntries: number, maxLength: number) {
  if (!value || typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.length > maxEntries) return false;
  return entries.every(
    ([fileName, content]) => PUBLISHABLE_FILE_NAME.test(fileName) && typeof content === "string" && content.length <= maxLength,
  );
}

export async function POST(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return NextResponse.json({ error: "Sign in with Hack Club first." }, { status: 401 });
  if (!session.github) return NextResponse.json({ error: "Connect GitHub first." }, { status: 401 });
  let github: GitHubConnection = session.github;
  let githubRefreshed = false;
  const githubResponse = async (body: unknown, init?: ResponseInit) => {
    const response = NextResponse.json(body, init);
    if (githubRefreshed) {
      response.cookies.set(
        SESSION_COOKIE,
        await encryptSession({ user: session.user, github, exp: session.exp }),
        sessionCookieOptions(),
      );
    }
    return response;
  };
  try {
    const { matchId, name, pages, files, description } = await request.json() as { matchId?: string; name?: string; pages?: Record<string, string>; files?: Record<string, string>; description?: string };
    if (!validFileMap(pages, 50, 1_000_000) || !pages!["index.html"]) return NextResponse.json({ error: "A valid website is required." }, { status: 400 });
    if (!matchId) return NextResponse.json({ error: "A match is required." }, { status: 400 });
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return NextResponse.json({ error: "Choose a valid build name." }, { status: 400 });
    const trimmedDescription = typeof description === "string" ? description.trim() : "";
    if (!trimmedDescription || trimmedDescription.length < 10 || trimmedDescription.length > 500) return NextResponse.json({ error: "A short description (at least a sentence) is required." }, { status: 400 });
    const hcaProfile = await getHackClubProfile(session.user.id);
    if (!completeSubmissionProfile(hcaProfile)) {
      return NextResponse.json(
        { error: "Reconnect Hack Club Auth so Ranked can load your birthday and addresses.", code: "hca_profile_required" },
        { status: 409 },
      );
    }
    const selectedAddress = resolvePrimaryAddress(hcaProfile);
    if (!selectedAddress) {
      return NextResponse.json(
        { error: "Add a complete primary address at auth.hackclub.com." },
        { status: 400 },
      );
    }
    const addressId = selectedAddress.id;
    const players = await getSql()`SELECT mp.team,m.theme,m.ends_at AS "endsAt" FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.match_id=${matchId} AND mp.user_id=${session.user.id}`;
    const player = players[0] as { team: "blue" | "red"; theme: string; endsAt: string } | undefined;
    if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
    if (new Date(player.endsAt).getTime() > Date.now()) return NextResponse.json({ error: "Publishing opens when the match timer ends." }, { status: 409 });
    const prior = await getSql()`SELECT id AS "publicationId",repository_url AS "repositoryUrl",pages_url AS "pagesUrl",
      airtable_status AS "airtableStatus" FROM publications
      WHERE match_id=${matchId} AND published_by=${session.user.id}`;
    if (prior[0]) {
      // A publication existing doesn't guarantee finished_at got set too — see
      // the comment below on the write transaction. Re-applying it here is
      // what lets a stuck match self-heal the moment the player is back.
      await getSql().transaction([
        getSql()`UPDATE publications SET hca_address_id=COALESCE(hca_address_id,${addressId})
          WHERE match_id=${matchId} AND published_by=${session.user.id}`,
        getSql()`UPDATE match_players SET finished_at=COALESCE(finished_at,NOW())
          WHERE match_id=${matchId} AND user_id=${session.user.id}`,
      ]);
      return NextResponse.json(prior[0]);
    }
    if (files !== undefined && !validFileMap(files, 50, 500_000)) return NextResponse.json({ error: "Invalid source files." }, { status: 400 });
    // Read before the commit so the freshly-published build can be folded
    // into the same directory-listing render inside publishWebsite, instead
    // of that listing needing its own follow-up commit after the fact.
    const existingBuilds = await getSql()`SELECT p.github_repo AS "folderName", m.theme, p.created_at AS "publishedAt"
      FROM publications p JOIN matches m ON m.id=p.match_id
      WHERE p.published_by=${session.user.id} ORDER BY p.created_at DESC`;
    github = await refreshGitHubConnection(session.github);
    githubRefreshed = github !== session.github;
    let result;
    try {
      result = await publishWebsite(github.accessToken, github.login, name, player.theme, pages!, files, trimmedDescription, existingBuilds as DirectoryBuild[]);
    } catch (error) {
      // A 403 enabling Pages can mean the installation's permissions were
      // just approved — the cached token issued beforehand keeps its old,
      // narrower scope until it's actually reissued, not just when it
      // happens to near its 8-hour expiry (see refreshGitHubConnection).
      // One forced reissue-and-retry covers that case automatically instead
      // of sending the player back to "approve" something they already did.
      if (!(error instanceof GitHubPermissionError)) throw error;
      github = await refreshGitHubConnection(github, { force: true });
      githubRefreshed = true;
      result = await publishWebsite(github.accessToken, github.login, name, player.theme, pages!, files, trimmedDescription, existingBuilds as DirectoryBuild[]);
    }
    const publicationId = crypto.randomUUID();
    // These used to run as separate round-trips. If the client disconnected
    // (tab closed right after publishing) between the publications insert and
    // the finished_at update, the build stayed published on GitHub but the
    // player kept getting handed back the same "finished" match on their next
    // visit — describe/publish and all — forever, since activeMatch() only
    // treats a match as done for a player once finished_at is set. One
    // transaction makes the whole thing all-or-nothing.
    const [, , , votingOpened] = await getSql().transaction([
      getSql()`INSERT INTO publications (id,match_id,team,repository_url,pages_url,github_repo,published_by,description)
        VALUES (${publicationId},${matchId},${player.team}::match_team,${result.repositoryUrl},${result.pagesUrl},${result.folderName},${session.user.id},${trimmedDescription})
        ON CONFLICT (match_id,published_by) DO NOTHING`,
      getSql()`UPDATE publications SET hca_address_id=${addressId}
        WHERE match_id=${matchId} AND published_by=${session.user.id}`,
      getSql()`UPDATE match_players SET finished_at=NOW() WHERE match_id=${matchId} AND user_id=${session.user.id}`,
      getSql()`UPDATE matches SET status='voting',voting_ends_at=NOW()+INTERVAL '24 hours'
        WHERE id=${matchId} AND status='active'
          AND (SELECT COUNT(*) FROM publications WHERE match_id=${matchId})=(SELECT COUNT(*) FROM match_players WHERE match_id=${matchId})
          AND (SELECT COUNT(DISTINCT team) FROM publications WHERE match_id=${matchId})=2
        RETURNING id`,
    ]);
    await addChallengeProgress(session.user.id, "publish_project", 1);
    if (votingOpened.length) {
      await logAudit({
        actor: null,
        action: "match.ended",
        summary: `A match ("${player.theme}") ended — every player published, community voting is open`,
        targetType: "match",
        targetId: matchId,
      });
    }

    const saved = await getSql()`SELECT id AS "publicationId",airtable_status AS "airtableStatus"
      FROM publications WHERE match_id=${matchId} AND published_by=${session.user.id} LIMIT 1`;
    return githubResponse({ ...result, ...saved[0] });
  } catch (error) {
    if (error instanceof GitHubCredentialsError) {
      const response = NextResponse.json(
        { error: error.message, code: "github_reconnect_required" },
        { status: 401 },
      );
      response.cookies.set(
        SESSION_COOKIE,
        await encryptSession({ user: session.user, exp: session.exp }),
        sessionCookieOptions(),
      );
      return response;
    }
    if (error instanceof GitHubRepoNotAccessibleError) {
      return githubResponse(
        { error: error.message, code: "github_repo_required" },
        { status: 409 },
      );
    }
    if (error instanceof GitHubPermissionError) {
      return githubResponse(
        {
          error: error.message,
          code: "github_permission_required",
          installationUrl: "https://github.com/settings/installations",
        },
        { status: 409 },
      );
    }
    console.error(error);
    return githubResponse({ error: error instanceof Error ? error.message : "Publishing failed." }, { status: 500 });
  }
}
