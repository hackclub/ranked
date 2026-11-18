import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

async function participant(matchId: string, userId: string) {
  const rows = await getSql()`SELECT team FROM match_players WHERE match_id=${matchId} AND user_id=${userId}`;
  return rows[0] as { team: "blue" | "red" } | undefined;
}

export async function GET(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const player = await participant(matchId, user.id);
  if (!player) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const opponent = player.team === "blue" ? "red" : "blue";
  const rows = await getSql()`SELECT html, updated_at AS "updatedAt" FROM match_snapshots WHERE match_id=${matchId} AND team=${opponent}::match_team`;
  return NextResponse.json({ snapshot: rows[0] ?? null });
}

export async function POST(request: NextRequest, context: { params: Promise<{ matchId: string }> }) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { matchId } = await context.params;
  const player = await participant(matchId, user.id);
  if (!player) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null);
  const html: unknown = body?.html;
  if (typeof html !== "string" || html.length > 1_000_000) return NextResponse.json({ error: "Invalid snapshot" }, { status: 400 });
  const opponent = player.team === "blue" ? "red" : "blue";
  // Fold the opponent read into the same round-trip as the write (rather than
  // a separate GET right after) so the client's poll loop stays at one
  // request per tick even as the tick rate increases.
  const [rows] = await Promise.all([
    getSql()`SELECT html, updated_at AS "updatedAt" FROM match_snapshots WHERE match_id=${matchId} AND team=${opponent}::match_team`,
    getSql()`INSERT INTO match_snapshots (match_id, team, html) VALUES (${matchId}, ${player.team}::match_team, ${html})
      ON CONFLICT (match_id, team) DO UPDATE SET html=EXCLUDED.html, updated_at=NOW()
      -- The client re-sends its build every few seconds whether or not it
      -- changed. updated_at has to mean "this team's build last changed":
      -- the heartbeat only counts coding time for a team whose build is moving.
      WHERE match_snapshots.html IS DISTINCT FROM EXCLUDED.html`,
  ]);
  return NextResponse.json({ ok: true, snapshot: rows[0] ?? null });
}

