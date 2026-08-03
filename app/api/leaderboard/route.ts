import { NextRequest, NextResponse } from "next/server";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const type = request.nextUrl.searchParams.get("type") === "hours" ? "hours" : "elo";
  const rows = type === "elo"
    ? await getSql()`SELECT id, name, elo AS score, avatar, matches_played AS "matchesPlayed" FROM users ORDER BY elo DESC, matches_played DESC LIMIT 100`
    : await getSql()`SELECT id, name, ROUND(coding_seconds/3600.0,1) AS score, avatar, matches_played AS "matchesPlayed" FROM users ORDER BY coding_seconds DESC LIMIT 100`;
  return NextResponse.json({ type, players: rows });
}

