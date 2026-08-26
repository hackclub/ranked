import { NextRequest, NextResponse } from "next/server";
import { publishWebsite, PUBLISHABLE_FILE_NAME, type DirectoryBuild } from "@/app/lib/github";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { logAudit } from "@/app/lib/audit";
import {
  completeSubmissionAddress,
  completeSubmissionProfile,
  getHackClubProfile,
} from "@/app/lib/hack-club-profile";
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
    const { matchId, name, pages, files, description, addressId } = await request.json() as { matchId?: string; name?: string; pages?: Record<string, string>; files?: Record<string, string>; description?: string; addressId?: string };
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
    const selectedAddress = hcaProfile?.addresses.find((address) => address.id === addressId);
    if (!addressId || !hcaProfile || !selectedAddress || !completeSubmissionAddress(hcaProfile, selectedAddress)) {
      return NextResponse.json({ error: "Choose one of your Hack Club Auth addresses." }, { status: 400 });
    }
    const players = await getSql()`SELECT mp.team,m.theme,m.ends_at AS "endsAt" FROM match_players mp JOIN matches m ON m.id=mp.match_id
      WHERE mp.match_id=${matchId} AND mp.user_id=${session.user.id}`;
    const player = players[0] as { team: "blue" | "red"; theme: string; endsAt: string } | undefined;
    if (!player) return NextResponse.json({ error: "You are not in this match." }, { status: 403 });
    if (new Date(player.endsAt).getTime() > Date.now()) return NextResponse.json({ error: "Publishing opens when the match timer ends." }, { status: 409 });
    const prior = await getSql()`SELECT id AS "publicationId",repository_url AS "repositoryUrl",pages_url AS "pagesUrl",
      airtable_status AS "airtableStatus" FROM publications
      WHERE match_id=${matchId} AND published_by=${session.user.id}`;
    if (prior[0]) {
      await getSql()`UPDATE publications SET hca_address_id=COALESCE(hca_address_id,${addressId})
        WHERE match_id=${matchId} AND published_by=${session.user.id}`;
      return NextResponse.json(prior[0]);
    }
    if (files !== undefined && !validFileMap(files, 50, 500_000)) return NextResponse.json({ error: "Invalid source files." }, { status: 400 });
    // Read before the commit so the freshly-published build can be folded
    // into the same directory-listing render inside publishWebsite, instead
    // of that listing needing its own follow-up commit after the fact.
    const existingBuilds = await getSql()`SELECT p.github_repo AS "folderName", m.theme, p.created_at AS "publishedAt"
      FROM publications p JOIN matches m ON m.id=p.match_id
      WHERE p.published_by=${session.user.id} ORDER BY p.created_at DESC`;
    const result = await publishWebsite(session.github.accessToken, session.github.login, name, player.theme, pages!, files, trimmedDescription, existingBuilds as DirectoryBuild[]);
    const publicationId = crypto.randomUUID();
    await getSql()`INSERT INTO publications (id,match_id,team,repository_url,pages_url,github_repo,published_by,description)
      VALUES (${publicationId},${matchId},${player.team}::match_team,${result.repositoryUrl},${result.pagesUrl},${result.folderName},${session.user.id},${trimmedDescription})
      ON CONFLICT (match_id,published_by) DO NOTHING`;
    await getSql()`UPDATE publications SET hca_address_id=${addressId}
      WHERE match_id=${matchId} AND published_by=${session.user.id}`;
    await getSql()`UPDATE match_players SET finished_at=NOW() WHERE match_id=${matchId} AND user_id=${session.user.id}`;
    const votingOpened = await getSql()`UPDATE matches SET status='voting',voting_ends_at=NOW()+INTERVAL '24 hours'
      WHERE id=${matchId} AND status='active'
        AND (SELECT COUNT(*) FROM publications WHERE match_id=${matchId})=(SELECT COUNT(*) FROM match_players WHERE match_id=${matchId})
        AND (SELECT COUNT(DISTINCT team) FROM publications WHERE match_id=${matchId})=2
      RETURNING id`;
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
    return NextResponse.json({ ...result, ...saved[0] });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Publishing failed." }, { status: 500 });
  }
}
