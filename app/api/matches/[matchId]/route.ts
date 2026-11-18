import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

export async function GET(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const matchRows = await getSql()`SELECT m.*, mp.team, mp.slot FROM matches m JOIN match_players mp ON mp.match_id=m.id
    WHERE m.id=${matchId} AND mp.user_id=${user.id}`;
  if (!matchRows.length) return NextResponse.json({ error: "Match not found" }, { status: 404 });
  const players = await getSql()`SELECT u.id, COALESCE(u.slack_username, split_part(u.name, ' ', 1)) AS name, u.avatar, mp.team, mp.slot FROM match_players mp JOIN users u ON u.id=mp.user_id
    WHERE mp.match_id=${matchId} ORDER BY mp.slot`;
  const publications = await getSql()`SELECT p.team,p.published_by AS "publishedBy",COALESCE(u.slack_username, split_part(u.name, ' ', 1)) AS name,
    p.repository_url AS "repositoryUrl",p.pages_url AS "pagesUrl" FROM publications p JOIN users u ON u.id=p.published_by WHERE p.match_id=${matchId}`;
  return NextResponse.json({ match: matchRows[0], players, publications });
}
