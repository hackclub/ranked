import { NextRequest, NextResponse } from "next/server";
import { currentUser, type DbUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

function auditActor(user: DbUser) {
  return { id: user.id, name: user.name, email: user.email };
}

async function upsertFriendship(requesterId: string, targetId: string) {
  const pairKey = [requesterId, targetId].sort().join(":");
  const rows = await getSql()`INSERT INTO friendships (id,requester_id,addressee_id,pair_key,status)
    VALUES (${crypto.randomUUID()},${requesterId},${targetId},${pairKey},'pending')
    ON CONFLICT (pair_key) DO UPDATE SET requester_id=EXCLUDED.requester_id, addressee_id=EXCLUDED.addressee_id,
      status=CASE WHEN friendships.status='declined' THEN 'pending'::friendship_status ELSE friendships.status END, updated_at=NOW()
    RETURNING id,status`;
  return rows[0];
}

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await getSql()`SELECT f.id, f.status, f.requester_id AS "requesterId", u.id AS "userId", u.name, u.slack_id AS "slackId", u.avatar
    FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=${user.id} THEN f.addressee_id ELSE f.requester_id END
    WHERE f.requester_id=${user.id} OR f.addressee_id=${user.id} ORDER BY f.updated_at DESC`;
  return NextResponse.json({ friends: rows });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const targetId = body.targetUserId as string | undefined;
  if (!targetId) return NextResponse.json({ error: "That person has not joined Ranked yet." }, { status: 404 });
  if (targetId === user.id) return NextResponse.json({ error: "You are already your own teammate." }, { status: 400 });
  const friendship = await upsertFriendship(user.id, targetId);
  if (friendship?.status === "pending") {
    await addChallengeProgress(user.id, "send_friend_request", 1);
    const target = await getSql()`SELECT name FROM users WHERE id=${targetId}`;
    await logAudit({
      actor: auditActor(user),
      action: "friend_request.sent",
      summary: `${user.name} sent a friend request to ${target[0]?.name ?? targetId}`,
      targetType: "friendship",
      targetId: friendship.id,
      metadata: { targetUserId: targetId },
    });
  }
  return NextResponse.json({ friendship });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { friendshipId, action } = await request.json();

  if (action === "block") {
    const rows = await getSql()`UPDATE friendships SET status='blocked', updated_at=NOW()
      WHERE id=${friendshipId} AND (requester_id=${user.id} OR addressee_id=${user.id})
      RETURNING id, (CASE WHEN requester_id=${user.id} THEN addressee_id ELSE requester_id END) AS "otherUserId"`;
    if (!rows.length) return NextResponse.json({ error: "Friend not found" }, { status: 404 });
    const other = await getSql()`SELECT name FROM users WHERE id=${rows[0].otherUserId}`;
    await logAudit({
      actor: auditActor(user),
      action: "friend.blocked",
      summary: `${user.name} blocked ${other[0]?.name ?? rows[0].otherUserId}`,
      targetType: "friendship",
      targetId: friendshipId,
      metadata: { otherUserId: rows[0].otherUserId },
    });
    return NextResponse.json({ ok: true, status: "blocked" });
  }

  if (action === "unfriend") {
    const rows = await getSql()`DELETE FROM friendships
      WHERE id=${friendshipId} AND (requester_id=${user.id} OR addressee_id=${user.id}) AND status='accepted' RETURNING id`;
    if (!rows.length) return NextResponse.json({ error: "Friend not found" }, { status: 404 });
    return NextResponse.json({ ok: true, status: "removed" });
  }

  if (action === "unblock") {
    const rows = await getSql()`DELETE FROM friendships
      WHERE id=${friendshipId} AND (requester_id=${user.id} OR addressee_id=${user.id}) AND status='blocked'
      RETURNING id, (CASE WHEN requester_id=${user.id} THEN addressee_id ELSE requester_id END) AS "otherUserId"`;
    if (!rows.length) return NextResponse.json({ error: "Blocked user not found" }, { status: 404 });
    const other = await getSql()`SELECT name FROM users WHERE id=${rows[0].otherUserId}`;
    await logAudit({
      actor: auditActor(user),
      action: "friend.unblocked",
      summary: `${user.name} unblocked ${other[0]?.name ?? rows[0].otherUserId}`,
      targetType: "friendship",
      targetId: friendshipId,
      metadata: { otherUserId: rows[0].otherUserId },
    });
    return NextResponse.json({ ok: true, status: "removed" });
  }

  const status = action === "accept" ? "accepted" : "declined";
  const rows = await getSql()`UPDATE friendships SET status=${status}::friendship_status, updated_at=NOW()
    WHERE id=${friendshipId} AND addressee_id=${user.id} AND status='pending' RETURNING requester_id AS "requesterId"`;
  if (!rows.length) return NextResponse.json({ error: "Friend request not found" }, { status: 404 });
  if (status === "accepted") {
    await Promise.all([addChallengeProgress(user.id, "add_friends", 1), addChallengeProgress(String(rows[0].requesterId), "add_friends", 1)]);
    const requester = await getSql()`SELECT name FROM users WHERE id=${rows[0].requesterId}`;
    await logAudit({
      actor: auditActor(user),
      action: "friend_request.accepted",
      summary: `${user.name} accepted ${requester[0]?.name ?? rows[0].requesterId}'s friend request`,
      targetType: "friendship",
      targetId: friendshipId,
      metadata: { requesterId: rows[0].requesterId },
    });
  }
  return NextResponse.json({ ok: true, status });
}

