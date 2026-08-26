import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch, generateMatchTheme } from "@/app/lib/match-lifecycle";
import { getVoteGate } from "@/app/lib/vote-gate";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

async function currentQueueState(userId: string) {
  const queued = await getSql()`
    SELECT q.joined_at AS "joinedAt",
      CASE
        WHEN q.mode='duo'::match_mode AND q.party_key IS NULL THEN 'finding_teammate'
        WHEN q.mode='duo'::match_mode AND (
          SELECT COUNT(*) FROM matchmaking_queue teammate
          WHERE teammate.party_key=q.party_key AND teammate.mode='duo'::match_mode
            AND teammate.duration_minutes=q.duration_minutes
        )<2 THEN 'waiting_for_teammate'
        WHEN q.mode='duo'::match_mode THEN 'waiting_for_opponents'
        ELSE 'searching'
      END AS phase
    FROM matchmaking_queue q WHERE q.user_id=${userId}
  `;
  return queued[0]
    ? { status: "queued", queued: queued[0], phase: queued[0].phase }
    : { status: "idle", queued: null };
}

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const match = await activeMatch(user.id);
  if (match) return NextResponse.json({ status: "matched", match });
  return NextResponse.json(await currentQueueState(user.id));
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
    FROM duo_invites WHERE status='accepted' AND (from_user_id=${user.id} OR to_user_id=${user.id})
    ORDER BY updated_at DESC LIMIT 1
  `;
  const partnership = partnerRow[0] as
    | { id: string; fromUserId: string; partnerId: string; durationMinutes: number }
    | undefined;
  if (!partnership && requestedMode === "duo") {
    const pendingInvite = await getSql()`SELECT 1 FROM duo_invites
      WHERE status='pending' AND (from_user_id=${user.id} OR to_user_id=${user.id})
        AND created_at>NOW()-INTERVAL '15 minutes' LIMIT 1`;
    if (pendingInvite.length) {
      return NextResponse.json(
        {
          error: "Respond to or cancel your pending duo invite before readying up.",
          code: "duo_invite_pending",
        },
        { status: 409 },
      );
    }
  }
  const mode = partnership ? "duo" : requestedMode;
  let partnerId = partnership?.partnerId as string | undefined;
  let partyKey = partnerId ? [user.id, partnerId].sort().join(":") : null;
  let duration = requestedDuration;
  if (partnership) {
    if (partnership.fromUserId === user.id) {
      duration = requestedDuration;
      await getSql().transaction([
        getSql()`UPDATE duo_invites SET duration_minutes=${requestedDuration},updated_at=NOW()
          WHERE id=${partnership.id} AND status='accepted'`,
        getSql()`UPDATE matchmaking_queue SET mode='duo'::match_mode,
          duration_minutes=${requestedDuration},party_key=${partyKey},joined_at=NOW()
          WHERE user_id=${partnerId}`,
      ]);
    } else {
      duration = partnership.durationMinutes;
    }
  }

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
          AND NOT EXISTS (
            SELECT 1 FROM duo_invites existing
            WHERE existing.status='accepted'
              AND q.user_id IN (existing.from_user_id,existing.to_user_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp JOIN matches m ON m.id=mp.match_id
            WHERE mp.user_id=q.user_id AND m.status='active' AND mp.finished_at IS NULL
          )
          AND (
            (u.matches_played < 3 AND q.experience = ${experience}::experience_level)
            OR (u.matches_played >= 3 AND ${user.matchesPlayed} >= 3 AND ABS(q.elo - ${user.elo}) <= 400)
          )
        ORDER BY q.joined_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED
      ), key AS (
        SELECT user_id AS "partnerId", LEAST(${user.id}, user_id) || ':' || GREATEST(${user.id}, user_id) AS "partyKey"
        FROM partner_candidate
      ), cleanup AS (
        UPDATE duo_invites di SET status='declined',updated_at=NOW()
        FROM key
        WHERE di.status IN ('pending','accepted')
          AND (di.from_user_id IN (${user.id}, key."partnerId") OR di.to_user_id IN (${user.id}, key."partnerId"))
        RETURNING di.id
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
  const theme = generateMatchTheme();
  // Both branches below only insert into `players`/delete from the queue when
  // they actually formed a match (gated on `made`, which only inserts when
  // enough candidates were found) — a non-empty result here is the only way
  // to tell whether *this* request was the one that just started a match,
  // versus one that simply left the requester still queued.
  let clearedQueue: Record<string, unknown>[] = [];
  if (mode === "solo") {
    clearedQueue = await getSql()`
      WITH candidate AS (
        SELECT q.user_id,q.joined_at
        FROM matchmaking_queue q JOIN users u ON u.id=q.user_id
        WHERE q.user_id<>${user.id} AND q.mode='solo'::match_mode
          AND q.duration_minutes=${duration}
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp JOIN matches m ON m.id=mp.match_id
            WHERE mp.user_id=q.user_id AND m.status='active' AND mp.finished_at IS NULL
          )
          AND (
            (u.matches_played<3 AND q.experience=${experience}::experience_level)
            OR (u.matches_played>=3 AND ${user.matchesPlayed}>=3 AND ABS(q.elo-${user.elo})<=400)
          )
        ORDER BY q.joined_at LIMIT 1 FOR UPDATE OF q SKIP LOCKED
      ), selected AS (
        SELECT ${user.id}::text AS user_id,0 AS ord
        UNION ALL SELECT user_id,1 FROM candidate
      ), made AS (
        INSERT INTO matches (id,mode,duration_minutes,theme,ends_at)
        SELECT ${matchId},'solo'::match_mode,${duration},${theme},
          NOW()+(${duration}||' minutes')::interval
        WHERE (SELECT COUNT(*) FROM selected)=2 RETURNING id
      ), players AS (
        INSERT INTO match_players (match_id,user_id,team,slot,pre_elo,last_heartbeat_at)
        SELECT made.id,s.user_id,
          CASE WHEN s.ord=0 THEN 'blue'::match_team ELSE 'red'::match_team END,
          s.ord,u.elo,NOW()
        FROM selected s JOIN users u ON u.id=s.user_id CROSS JOIN made
        RETURNING user_id
      )
      DELETE FROM matchmaking_queue q USING players p WHERE q.user_id=p.user_id RETURNING p.user_id AS "userId"
    `;
  } else if (partyKey) {
    // A duo match is assembled from two complete party keys. This is the
    // invariant that keeps an invited teammate together and prevents a queued
    // player from being pulled into somebody else's half-full team.
    clearedQueue = await getSql()`
      WITH opponent_party AS (
        SELECT q.party_key,MIN(q.joined_at) AS first_joined
        FROM matchmaking_queue q JOIN users u ON u.id=q.user_id
        WHERE q.party_key IS NOT NULL AND q.party_key<>${partyKey}
          AND q.mode='duo'::match_mode AND q.duration_minutes=${duration}
          AND EXISTS (
            SELECT 1 FROM duo_invites di WHERE di.status='accepted'
              AND q.party_key=LEAST(di.from_user_id,di.to_user_id)||':'||GREATEST(di.from_user_id,di.to_user_id)
          )
          AND NOT EXISTS (
            SELECT 1 FROM match_players mp JOIN matches m ON m.id=mp.match_id
            WHERE mp.user_id=q.user_id AND m.status='active' AND mp.finished_at IS NULL
          )
        GROUP BY q.party_key
        HAVING COUNT(*)=2 AND BOOL_AND(
          (u.matches_played<3 AND q.experience=${experience}::experience_level)
          OR (u.matches_played>=3 AND ${user.matchesPlayed}>=3 AND ABS(q.elo-${user.elo})<=400)
        )
        ORDER BY first_joined LIMIT 1
      ), locked_candidates AS (
        SELECT q.user_id,q.party_key,q.joined_at
        FROM matchmaking_queue q
        WHERE q.user_id<>${user.id} AND q.mode='duo'::match_mode
          AND q.duration_minutes=${duration} AND (
            q.party_key=${partyKey} OR
            q.party_key=(SELECT party_key FROM opponent_party)
          )
        ORDER BY (q.party_key=${partyKey}) DESC,q.joined_at
        FOR UPDATE OF q SKIP LOCKED
      ), own_teammate AS (
        SELECT user_id FROM locked_candidates WHERE party_key=${partyKey} LIMIT 1
      ), opponents AS (
        SELECT user_id,ROW_NUMBER() OVER (ORDER BY joined_at)::int+1 AS ord
        FROM locked_candidates WHERE party_key=(SELECT party_key FROM opponent_party)
      ), selected AS (
        SELECT ${user.id}::text AS user_id,0 AS ord
        UNION ALL SELECT user_id,1 FROM own_teammate
        UNION ALL SELECT user_id,ord FROM opponents
      ), made AS (
        INSERT INTO matches (id,mode,duration_minutes,theme,ends_at)
        SELECT ${matchId},'duo'::match_mode,${duration},${theme},
          NOW()+(${duration}||' minutes')::interval
        WHERE (SELECT COUNT(*) FROM own_teammate)=1
          AND (SELECT COUNT(*) FROM opponents)=2
        RETURNING id
      ), players AS (
        INSERT INTO match_players (match_id,user_id,team,slot,pre_elo,last_heartbeat_at)
        SELECT made.id,s.user_id,
          CASE WHEN s.ord<2 THEN 'blue'::match_team ELSE 'red'::match_team END,
          s.ord,u.elo,NOW()
        FROM selected s JOIN users u ON u.id=s.user_id CROSS JOIN made
        RETURNING user_id
      )
      DELETE FROM matchmaking_queue q USING players p WHERE q.user_id=p.user_id RETURNING p.user_id AS "userId"
    `;
  }
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
  return NextResponse.json(
    match ? { status: "matched", match } : await currentQueueState(user.id),
  );
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const deleted = await getSql()`
    WITH current_entry AS (
      SELECT party_key FROM matchmaking_queue WHERE user_id=${user.id}
    ), removed AS (
      DELETE FROM matchmaking_queue q
      WHERE q.user_id=${user.id} OR (
        q.party_key IS NOT NULL AND q.party_key=(SELECT party_key FROM current_entry)
      )
      RETURNING user_id
    )
    SELECT COUNT(*)::int AS count FROM removed
  `;
  return NextResponse.json({ ok: true, cleared: deleted[0]?.count ?? 0 });
}
