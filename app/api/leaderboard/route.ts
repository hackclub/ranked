import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/db";
import { currentUser } from "@/app/lib/current-user";

const PAGE_SIZE = 10;

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type") === "hours" ? "hours" : "elo";
  const user = await currentUser(request);
  // Player handles, account ids and stats are for players, not for anyone on
  // the internet who finds this URL.
  if (!user) return NextResponse.json({ error: "Sign in to see the leaderboard." }, { status: 401 });
  const sql = getSql();

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM users`;
  const totalPlayers = Number(count);
  const totalPages = Math.max(1, Math.ceil(totalPlayers / PAGE_SIZE));

  let yourRank: number | null = null;
  if (user) {
    const rankRows = type === "elo"
      ? await sql`SELECT (COUNT(*) FILTER (WHERE elo > ${user.elo} OR (elo = ${user.elo} AND matches_played > ${user.matchesPlayed})))::int + 1 AS rank FROM users`
      : await sql`SELECT (COUNT(*) FILTER (WHERE coding_seconds > ${user.codingSeconds}))::int + 1 AS rank FROM users`;
    yourRank = Number((rankRows[0] as { rank: number } | undefined)?.rank) || null;
  }
  const yourPage = yourRank ? Math.ceil(yourRank / PAGE_SIZE) : null;

  // Floored: a fractional page would otherwise reach OFFSET as a non-integer
  // and fail the query.
  const requestedPage = Math.floor(Number(request.nextUrl.searchParams.get("page")));
  const page = Math.min(
    Math.max(1, Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : (yourPage ?? 1)),
    totalPages,
  );
  const offset = (page - 1) * PAGE_SIZE;

  const rows = type === "elo"
    ? await sql`SELECT id, COALESCE(slack_username, split_part(name, ' ', 1)) AS name, elo AS score, avatar, banner_color AS "bannerColor", matches_played AS "matchesPlayed" FROM users ORDER BY elo DESC, matches_played DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`
    : await sql`SELECT id, COALESCE(slack_username, split_part(name, ' ', 1)) AS name, ROUND(coding_seconds/3600.0,1) AS score, avatar, banner_color AS "bannerColor", matches_played AS "matchesPlayed" FROM users ORDER BY coding_seconds DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`;

  return NextResponse.json({
    type,
    page,
    pageSize: PAGE_SIZE,
    totalPlayers,
    totalPages,
    players: rows,
    yourRank,
    yourPage,
  });
}
