import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { activeMatch } from "@/app/lib/match-lifecycle";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

type InvitePartner = {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerAvatar: { color: string; eyes: number; mouths: number };
  partnerQueued?: boolean;
  isCreator?: boolean;
  durationMinutes?: number;
};
type MissedInvite = { id: string; partnerName: string; partnerAvatar: { color: string; eyes: number; mouths: number } };

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sql = getSql();
  const [partner, outgoing, incoming, missed] = await Promise.all([
    sql`SELECT di.id, (CASE WHEN di.from_user_id=${user.id} THEN di.to_user_id ELSE di.from_user_id END) AS "partnerId",
        u.name AS "partnerName", u.avatar AS "partnerAvatar",
        (di.from_user_id=${user.id}) AS "isCreator", di.duration_minutes AS "durationMinutes",
        EXISTS(SELECT 1 FROM matchmaking_queue q WHERE q.user_id = (CASE WHEN di.from_user_id=${user.id} THEN di.to_user_id ELSE di.from_user_id END)) AS "partnerQueued"
      FROM duo_invites di JOIN users u ON u.id = (CASE WHEN di.from_user_id=${user.id} THEN di.to_user_id ELSE di.from_user_id END)
      WHERE di.status='accepted' AND (di.from_user_id=${user.id} OR di.to_user_id=${user.id})
      ORDER BY di.updated_at DESC LIMIT 1`,
    sql`SELECT di.id, di.to_user_id AS "partnerId", u.name AS "partnerName", u.avatar AS "partnerAvatar"
      FROM duo_invites di JOIN users u ON u.id=di.to_user_id
      WHERE di.from_user_id=${user.id} AND di.status='pending' ORDER BY di.created_at DESC LIMIT 1`,
    sql`SELECT di.id, di.from_user_id AS "partnerId", u.name AS "partnerName", u.avatar AS "partnerAvatar"
      FROM duo_invites di JOIN users u ON u.id=di.from_user_id
      WHERE di.to_user_id=${user.id} AND di.status='pending' ORDER BY di.created_at DESC`,
    sql`SELECT di.id, u.name AS "partnerName", u.avatar AS "partnerAvatar"
      FROM duo_invites di JOIN users u ON u.id=di.from_user_id
      WHERE di.to_user_id=${user.id} AND di.status='missed' ORDER BY di.created_at DESC`,
  ]);
  return NextResponse.json({
    partner: (partner[0] as InvitePartner | undefined) ?? null,
    outgoing: (outgoing[0] as InvitePartner | undefined) ?? null,
    incoming: incoming as InvitePartner[],
    missed: missed as MissedInvite[],
  });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { friendId, durationMinutes } = await request.json() as { friendId?: string; durationMinutes?: number };
  if (!friendId || friendId === user.id) return NextResponse.json({ error: "Choose a friend to invite." }, { status: 400 });
  const duration = [10, 30, 60].includes(Number(durationMinutes)) ? Number(durationMinutes) : 30;
  const sql = getSql();
  const friendship = await sql`SELECT 1 FROM friendships WHERE status='accepted'
    AND ((requester_id=${user.id} AND addressee_id=${friendId}) OR (requester_id=${friendId} AND addressee_id=${user.id}))`;
  if (!friendship.length) return NextResponse.json({ error: "You can only invite accepted friends." }, { status: 400 });
  const friend = await sql`SELECT name, avatar FROM users WHERE id=${friendId}`;
  if (!friend[0]) return NextResponse.json({ error: "That player no longer exists." }, { status: 404 });

  // Reuses activeMatch's definition of "still in a match" — a match stays
  // status='active' until every player has published, so a player who's
  // already finished their own side must not read as unavailable just
  // because their opponent hasn't finished yet.
  const inMatch = await activeMatch(friendId);
  if (inMatch) {
    await sql`INSERT INTO duo_invites (id, from_user_id, to_user_id, status) VALUES (${crypto.randomUUID()}, ${user.id}, ${friendId}, 'missed')`;
    return NextResponse.json(
      { error: `${friend[0].name} is currently playing a match — try inviting them again once they're done.` },
      { status: 409 },
    );
  }

  await sql`DELETE FROM duo_invites WHERE status IN ('pending','accepted') AND (from_user_id=${user.id} OR to_user_id=${user.id})`;
  const inserted = await sql`INSERT INTO duo_invites (id, from_user_id, to_user_id, duration_minutes) VALUES (${crypto.randomUUID()}, ${user.id}, ${friendId}, ${duration}) RETURNING id`;
  await logAudit({
    actor: { id: user.id, name: user.name, email: user.email },
    action: "match_invite.sent",
    summary: `${user.name} invited ${friend[0].name} to a duo match (${duration} min)`,
    targetType: "duo_invite",
    targetId: inserted[0].id,
    metadata: { partnerId: friendId, durationMinutes: duration },
  });
  return NextResponse.json({ outgoing: { id: inserted[0].id, partnerId: friendId, partnerName: friend[0].name, partnerAvatar: friend[0].avatar } });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { inviteId, action, durationMinutes } = await request.json() as {
    inviteId?: string;
    action?: string;
    durationMinutes?: number;
  };
  if (!inviteId) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const sql = getSql();
  // Only the duo's creator (from_user_id) can change match settings — the
  // joiner's client never sends this, but the check is enforced here too.
  if (durationMinutes !== undefined) {
    if (![10, 30, 60].includes(Number(durationMinutes)))
      return NextResponse.json({ error: "Invalid match length." }, { status: 400 });
    await sql`UPDATE duo_invites SET duration_minutes=${Number(durationMinutes)}, updated_at=NOW()
      WHERE id=${inviteId} AND from_user_id=${user.id} AND status IN ('pending','accepted')`;
    return NextResponse.json({ ok: true });
  }
  if (action !== "accept" && action !== "decline" && action !== "acknowledge")
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  if (action === "acknowledge") {
    await sql`UPDATE duo_invites SET status='declined', updated_at=NOW() WHERE id=${inviteId} AND to_user_id=${user.id} AND status='missed'`;
    return NextResponse.json({ ok: true });
  }
  if (action === "decline") {
    await sql`UPDATE duo_invites SET status='declined', updated_at=NOW() WHERE id=${inviteId} AND to_user_id=${user.id} AND status='pending'`;
    return NextResponse.json({ ok: true });
  }
  const accepted = await sql`UPDATE duo_invites SET status='accepted', updated_at=NOW()
    WHERE id=${inviteId} AND to_user_id=${user.id} AND status='pending' RETURNING id`;
  if (!accepted.length) return NextResponse.json({ error: "That invite is no longer available." }, { status: 404 });
  await sql`UPDATE duo_invites SET status='declined', updated_at=NOW()
    WHERE id<>${inviteId} AND status IN ('pending','accepted') AND (from_user_id=${user.id} OR to_user_id=${user.id})`;
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  await getSql()`DELETE FROM duo_invites WHERE status IN ('pending','accepted') AND (from_user_id=${user.id} OR to_user_id=${user.id})`;
  return NextResponse.json({ ok: true });
}
