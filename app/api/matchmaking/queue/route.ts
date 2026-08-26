import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch, generateMatchTheme } from "@/app/lib/match-lifecycle";
import { getVoteGate } from "@/app/lib/vote-gate";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const match = await activeMatch(user.id);
  if (match) return NextResponse.json({ status: "matched", match });
  const queued = await getSql()`SELECT joined_at AS "joinedAt" FROM matchmaking_queue WHERE user_id = ${user.id}`;
  return NextResponse.json({ status: queued.length ? "queued" : "idle", queued: queued[0] ?? null });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const existing = await activeMatch(user.id);
  if (existing) return NextResponse.json({ status: "matched", match: existing });
  if (!user.hackatimeConnected) {
    return NextResponse.json(
      { error: "Connect Hackatime before joining a match.", code: "hackatime_required" },
      { status: 403 },
    );
  }
  const body = await request.json();
  const requestedMode = body.mode === "duo" ? "duo" : "solo";
  const requestedDuration = [10, 30, 60].includes(Number(body.durationMinutes)) ? Number(body.durationMinutes) : 10;
  const experience = ["beginner", "intermediate", "expert"].includes(body.experience) ? body.experience : user.experience;
  if (!experience) return NextResponse.json({ error: "Choose your experience level first.", code: "onboarding_required" }, { status: 400 });
  const voteGate = await getVoteGate(user.id, user.matchesPlayed);
  if (voteGate.due) {
    return NextResponse.json({ error: "Vote on a finished match to keep playing.", code: "vote_required" }, { status: 403 });
  }

  // An accepted duo partner is the authority on match settings, resolved
  // here rather than trusted from either client — that's the only way to
  // guarantee two partnered players can never queue with different
  // mode/duration. The creator's request re-persists their chosen duration;
  // the joiner's request ignores whatever it sent and uses that value.
  const partnerRow = await getSql()`
    SELECT id, from_user_id AS "fromUserId",
      (CASE WHEN from_user_id=${user.id} THEN to_user_id ELSE from_user_id END) AS "partnerId",
      duration_minutes AS "durationMinutes"
    FROM duo_invites WHERE status='accepted' AND (from_user_id=${user.id} OR to_user_id=${user.id}) LIMIT 1
  `;
  const partnership = partnerRow[0] as
    | { id: string; fromUserId: string; partnerId: string; durationMinutes: number }
    | undefined;
  const mode = partnership ? "duo" : requestedMode;
  let duration = requestedDuration;
  if (partnership) {
    if (partnership.fromUserId === user.id) {
      await getSql()`UPDATE duo_invites SET duration_minutes=${requestedDuration}, updated_at=NOW() WHERE id=${partnership.id}`;
      duration = requestedDuration;
    } else {
      duration = partnership.durationMinutes;
    }
  }
  let partnerId = partnership?.partnerId as string | undefined;
  let partyKey = partnerId ? [user.id, partnerId].sort().join(":") : null;

  // Duo player readied up with their partner slot open: auto-pair them with another
  // partner-less duo queuer using the same experience/elo eligibility as opponent matching,
  // so they get a partner instead of waiting for four strangers to queue at once.
  if (mode === "duo" && !partnerId) {
    const claimed = await getSql()`
      WITH partner_candidate AS (
        SELECT q.user_id
        FROM matchmaking_queue q JOIN users u ON u.id = q.user_id
        WHERE q.party_key IS NULL AND q.mode = 'duo'::match_mode AND q.duration_minutes = ${duration}
          AND q.user_id <> ${user.id}
          AND (
            (u.matches_played < 3 AND q.experience = ${experience}::experience_level)
            OR (u.matches_played >= 3 AND ${user.matchesPlayed} >= 3 AND ABS(q.elo - ${user.elo}) <= 400)
          )
        ORDER BY q.joined_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED
      ), key AS (
        SELECT user_id AS "partnerId", LEAST(${user.id}, user_id) || ':' || GREATEST(${user.id}, user_id) AS "partyKey"
        FROM partner_candidate
      ), cleanup AS (
        DELETE FROM duo_invites di USING key
        WHERE di.status IN ('pending','accepted')
          AND (di.from_user_id IN (${user.id}, key."partnerId") OR di.to_user_id IN (${user.id}, key."partnerId"))
        RETURNING 1
      ), invite AS (
        INSERT INTO duo_invites (id, from_user_id, to_user_id, status, duration_minutes)
        SELECT ${crypto.randomUUID()}, ${user.id}, "partnerId", 'accepted', ${duration} FROM key
        RETURNING 1
      ), claimed AS (
        UPDATE matchmaking_queue q SET party_key = key."partyKey"
        FROM key WHERE q.user_id = key."partnerId"
        RETURNING 1
      )
      SELECT "partnerId", "partyKey" FROM key
    `;
    if (claimed[0]) {
      partnerId = claimed[0].partnerId as string;
      partyKey = claimed[0].partyKey as string;
    }
  }

  await getSql()`UPDATE users SET experience = ${experience}::experience_level WHERE id = ${user.id}`;
  await getSql()`INSERT INTO matchmaking_queue (user_id, mode, duration_minutes, experience, elo, party_key)
    VALUES (${user.id}, ${mode}::match_mode, ${duration}, ${experience}::experience_level, ${user.elo}, ${partyKey})
    ON CONFLICT (user_id) DO UPDATE SET mode=EXCLUDED.mode, duration_minutes=EXCLUDED.duration_minutes,
      experience=EXCLUDED.experience, elo=EXCLUDED.elo, party_key=EXCLUDED.party_key, joined_at=NOW()`;

  const matchId = crypto.randomUUID();
  const needed = mode === "duo" ? 4 : 2;
  const theme = generateMatchTheme();
  const clearedQueue = await getSql()`
    WITH candidates AS (
      SELECT q.user_id, q.joined_at, COALESCE(${partyKey}::text IS NOT NULL AND q.party_key=${partyKey}, false) AS is_party
      FROM matchmaking_queue q JOIN users u ON u.id=q.user_id
      WHERE q.user_id <> ${user.id} AND q.mode=${mode}::match_mode AND q.duration_minutes=${duration}
        AND (
          (${partyKey}::text IS NOT NULL AND q.party_key=${partyKey})
          OR (u.matches_played < 3 AND q.experience=${experience}::experience_level)
          OR (u.matches_played >= 3 AND ${user.matchesPlayed} >= 3 AND ABS(q.elo-${user.elo}) <= 400)
        )
      ORDER BY is_party DESC, q.joined_at LIMIT ${needed - 1} FOR UPDATE OF q SKIP LOCKED
    ), selected AS (
      SELECT ${user.id}::text AS user_id, 0 AS ord UNION ALL
      SELECT user_id, ROW_NUMBER() OVER (ORDER BY is_party DESC, joined_at)::int AS ord FROM candidates
    ), made AS (
      INSERT INTO matches (id, mode, duration_minutes, theme, ends_at)
      SELECT ${matchId}, ${mode}::match_mode, ${duration}, ${theme}, NOW() + (${duration} || ' minutes')::interval
      WHERE (SELECT COUNT(*) FROM selected) = ${needed} RETURNING id
    ), players AS (
      INSERT INTO match_players (match_id, user_id, team, slot, pre_elo, last_heartbeat_at)
      SELECT made.id, s.user_id,
        CASE WHEN s.ord < ${needed / 2} THEN 'blue'::match_team ELSE 'red'::match_team END,
        s.ord, u.elo, NOW() FROM selected s JOIN users u ON u.id=s.user_id CROSS JOIN made RETURNING user_id
    )
    DELETE FROM matchmaking_queue q USING players p WHERE q.user_id=p.user_id RETURNING p.user_id AS "userId"
  `;
  // The CTE above only inserts into `players`/deletes from the queue when it
  // actually formed a match (gated on `made`, which only inserts when enough
  // candidates were found) — a non-empty result here is the only way to tell
  // whether *this* request was the one that just started a match, versus one
  // that simply left the requester still queued.
  if (clearedQueue.length) {
    const roster = await getSql()`SELECT u.name, mp.team FROM match_players mp JOIN users u ON u.id=mp.user_id
      WHERE mp.match_id=${matchId} ORDER BY mp.slot`;
    await logAudit({
      actor: null,
      action: "match.started",
      summary: `A ${mode} match ("${theme}") started — ${roster.map((p) => `${p.name} (${p.team})`).join(", ")}`,
      targetType: "match",
      targetId: matchId,
      metadata: { mode, durationMinutes: duration, theme, players: roster },
    });
  }
  const match = await activeMatch(user.id);
  return NextResponse.json(match ? { status: "matched", match } : { status: "queued" });
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await getSql()`DELETE FROM matchmaking_queue WHERE user_id = ${user.id}`;
  return NextResponse.json({ ok: true });
}
