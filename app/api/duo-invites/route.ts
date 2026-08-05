import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";

type InvitePartner = { id: string; partnerId: string; partnerName: string; partnerAvatar: { color: string; eyes: number; mouths: number }; partnerQueued?: boolean };

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sql = getSql();
  const [partner, outgoing, incoming] = await Promise.all([
    sql`SELECT di.id, (CASE WHEN di.from_user_id=${user.id} THEN di.to_user_id ELSE di.from_user_id END) AS "partnerId",
        u.name AS "partnerName", u.avatar AS "partnerAvatar",
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
  ]);
  return NextResponse.json({
    partner: (partner[0] as InvitePartner | undefined) ?? null,
    outgoing: (outgoing[0] as InvitePartner | undefined) ?? null,
    incoming: incoming as InvitePartner[],
  });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { friendId } = await request.json() as { friendId?: string };
  if (!friendId || friendId === user.id) return NextResponse.json({ error: "Choose a friend to invite." }, { status: 400 });
  const sql = getSql();
  const friendship = await sql`SELECT 1 FROM friendships WHERE status='accepted'
    AND ((requester_id=${user.id} AND addressee_id=${friendId}) OR (requester_id=${friendId} AND addressee_id=${user.id}))`;
  if (!friendship.length) return NextResponse.json({ error: "You can only invite accepted friends." }, { status: 400 });
  const friend = await sql`SELECT name, avatar FROM users WHERE id=${friendId}`;
  if (!friend[0]) return NextResponse.json({ error: "That player no longer exists." }, { status: 404 });
  await sql`DELETE FROM duo_invites WHERE status IN ('pending','accepted') AND (from_user_id=${user.id} OR to_user_id=${user.id})`;
  const inserted = await sql`INSERT INTO duo_invites (id, from_user_id, to_user_id) VALUES (${crypto.randomUUID()}, ${user.id}, ${friendId}) RETURNING id`;
  return NextResponse.json({ outgoing: { id: inserted[0].id, partnerId: friendId, partnerName: friend[0].name, partnerAvatar: friend[0].avatar } });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { inviteId, action } = await request.json() as { inviteId?: string; action?: string };
  if (!inviteId || (action !== "accept" && action !== "decline")) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  const sql = getSql();
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
