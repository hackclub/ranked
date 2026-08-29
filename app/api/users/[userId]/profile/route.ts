import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

// Every publication's repository_url/pages_url points at a specific match
// folder (…/hackclubranked/tree/main/{folder}, {login}.github.io/hackclubranked/{folder}/)
// — there's no column that stores the bare repo root, so it's derived from
// whichever publication happens to be most recent rather than duplicating
// GitHub login storage just for this.
const REPO_ROOT_PATTERN = /^(https:\/\/github\.com\/[^/]+\/hackclubranked)\//;
const PAGES_ROOT_PATTERN = /^(https:\/\/[^/]+\.github\.io\/hackclubranked\/)/;

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ userId: string }> },
) {
  const viewer = await currentUser(request);
  if (!viewer) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { userId } = await context.params;

  const rows = await getSql()`SELECT id, COALESCE(slack_username, name) AS name, avatar, elo, coding_seconds AS "codingSeconds",
      matches_played AS "matchesPlayed", banner_color AS "bannerColor"
    FROM users WHERE id=${userId}`;
  const player = rows[0] as
    | {
        id: string;
        name: string;
        avatar: unknown;
        elo: number;
        codingSeconds: number;
        matchesPlayed: number;
        bannerColor: string | null;
      }
    | undefined;
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  const latestPublication = await getSql()`SELECT repository_url AS "repositoryUrl", pages_url AS "pagesUrl"
    FROM publications WHERE published_by=${userId} ORDER BY created_at DESC LIMIT 1`;
  const publication = latestPublication[0] as
    | { repositoryUrl: string; pagesUrl: string }
    | undefined;
  let githubRepoUrl = publication?.repositoryUrl.match(REPO_ROOT_PATTERN)?.[1] ?? null;
  let githubGalleryUrl = publication?.pagesUrl.match(PAGES_ROOT_PATTERN)?.[1] ?? null;

  // No publication row doesn't mean no repo — it only means this player has
  // never published *through Ranked*. Hackatime's OAuth already captured
  // their GitHub username independently, so fall back to the same
  // hackclubranked naming convention every publish uses, rather than
  // showing no link at all for someone who clearly has GitHub connected.
  if (!githubRepoUrl && !githubGalleryUrl) {
    const hackatime = await getSql()`SELECT github_username AS "githubUsername"
      FROM hackatime_connections WHERE user_id=${userId}`;
    const githubUsername = (hackatime[0] as { githubUsername: string | null } | undefined)
      ?.githubUsername;
    if (githubUsername) {
      githubRepoUrl = `https://github.com/${githubUsername}/hackclubranked`;
      githubGalleryUrl = `https://${githubUsername}.github.io/hackclubranked/`;
    }
  }

  return NextResponse.json({
    id: player.id,
    name: player.name,
    avatar: player.avatar,
    elo: player.elo,
    hours: Math.round(player.codingSeconds / 360) / 10,
    matchesPlayed: player.matchesPlayed,
    bannerColor: player.bannerColor,
    githubRepoUrl,
    githubGalleryUrl,
  });
}
