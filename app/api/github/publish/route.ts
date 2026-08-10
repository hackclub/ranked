import { NextRequest, NextResponse } from "next/server";
import { publishWebsite, updateDirectoryIndex, PUBLISHABLE_FILE_NAME, type DirectoryBuild } from "@/app/lib/github";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
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
  try {
    const { matchId, name, pages, files } = await request.json() as { matchId?: string; name?: string; pages?: Record<string, string>; files?: Record<string, string> };
    if (!validFileMap(pages, 50, 1_000_000) || !pages!["index.html"]) return NextResponse.json({ error: "A valid website is required." }, { status: 400 });
    if (!matchId) return NextResponse.json({ error: "A match is required." }, { status: 400 });
    if (!name || !/^[A-Za-z0-9._-]{1,100}$/.test(name) || name === "." || name === "..") return NextResponse.json({ error: "Choose a valid build name." }, { status: 400 });
    const players = await getSql()`SELECT mp.team,m.theme,m.ends_at AS "endsAt" FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.match_id=${matchId} AND mp.user_id=${session.user.id}`;
    const player = players[0] as { team: "blue" | "red"; theme: string; endsAt: string } | undefined;
    if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
    if (new Date(player.endsAt).getTime() > Date.now()) return NextResponse.json({ error: "Publishing opens when the match timer ends." }, { status: 409 });
    const prior = await getSql()`SELECT repository_url AS "repositoryUrl",pages_url AS "pagesUrl" FROM publications
      WHERE match_id=${matchId} AND published_by=${session.user.id}`;
    if (prior[0]) return NextResponse.json(prior[0]);
    if (files !== undefined && !validFileMap(files, 50, 500_000)) return NextResponse.json({ error: "Invalid source files." }, { status: 400 });
    const result = await publishWebsite(session.github.accessToken, session.github.login, name, pages!, files);
    await getSql()`INSERT INTO publications (id,match_id,team,repository_url,pages_url,github_repo,published_by)
      VALUES (${crypto.randomUUID()},${matchId},${player.team}::match_team,${result.repositoryUrl},${result.pagesUrl},${result.folderName},${session.user.id})
      ON CONFLICT (match_id,published_by) DO NOTHING`;
    await getSql()`UPDATE match_players SET finished_at=NOW() WHERE match_id=${matchId} AND user_id=${session.user.id}`;
    await getSql()`UPDATE matches SET status='voting',voting_ends_at=NOW()+INTERVAL '24 hours'
      WHERE id=${matchId} AND status='active'
        AND (SELECT COUNT(*) FROM publications WHERE match_id=${matchId})=(SELECT COUNT(*) FROM match_players WHERE match_id=${matchId})
        AND (SELECT COUNT(DISTINCT team) FROM publications WHERE match_id=${matchId})=2`;

    const builds = await getSql()`SELECT p.github_repo AS "folderName", m.theme, p.created_at AS "publishedAt"
      FROM publications p JOIN matches m ON m.id=p.match_id
      WHERE p.published_by=${session.user.id} ORDER BY p.created_at DESC`;
    try {
      await updateDirectoryIndex(session.github.accessToken, session.github.login, builds as DirectoryBuild[]);
    } catch (error) {
      console.error("Failed to update builds directory index", error);
    }

    return NextResponse.json(result);
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Publishing failed." }, { status: 500 });
  }
}
