import { NextRequest, NextResponse } from "next/server";
import { currentUser, type DbUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { logAudit } from "@/app/lib/audit";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { getSql } from "@/db";

function auditActor(user: DbUser) {
  return { id: user.id, name: user.name, email: user.email };
}

// A 'blocked' row is frozen: a new request from either side must not reopen
// it, and must not swap requester/addressee (which is how the blocked person
// could otherwise make the row look like theirs to manage). previousStatus
// lets the caller tell a brand-new request from a repeat of one that was
// already pending.
async function upsertFriendship(requesterId: string, targetId: string) {
  const pairKey = [requesterId, targetId].sort().join(":");
  const rows = await getSql()`WITH previous AS (
      SELECT status FROM friendships WHERE pair_key=${pairKey}
    )
    INSERT INTO friendships (id,requester_id,addressee_id,pair_key,status)
    VALUES (${crypto.randomUUID()},${requesterId},${targetId},${pairKey},'pending')
    ON CONFLICT (pair_key) DO UPDATE SET
      requester_id=CASE WHEN friendships.status='blocked' THEN friendships.requester_id ELSE EXCLUDED.requester_id END,
      addressee_id=CASE WHEN friendships.status='blocked' THEN friendships.addressee_id ELSE EXCLUDED.addressee_id END,
      status=CASE WHEN friendships.status='declined' THEN 'pending'::friendship_status ELSE friendships.status END,
      updated_at=CASE WHEN friendships.status='blocked' THEN friendships.updated_at ELSE NOW() END
    RETURNING id,status,blocked_by AS "blockedBy",(SELECT status FROM previous) AS "previousStatus"`;
  return rows[0] as
    | { id: string; status: string; blockedBy: string | null; previousStatus: string | null }
    | undefined;
}

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const rows = await getSql()`SELECT f.id, f.status, f.requester_id AS "requesterId", u.id AS "userId", COALESCE(u.slack_username, split_part(u.name, ' ', 1)) AS name, u.avatar
    FROM friendships f JOIN users u ON u.id=CASE WHEN f.requester_id=${user.id} THEN f.addressee_id ELSE f.requester_id END
    WHERE (f.requester_id=${user.id} OR f.addressee_id=${user.id})
      AND (f.status<>'blocked' OR f.blocked_by=${user.id} OR f.blocked_by IS NULL)
    ORDER BY f.updated_at DESC`;
  return NextResponse.json({ friends: rows });
}

export async function POST(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => null);
  const targetId = typeof body?.targetUserId === "string" ? body.targetUserId : undefined;
  if (!targetId) return NextResponse.json({ error: "That person has not joined Ranked yet." }, { status: 404 });
  if (targetId === user.id) return NextResponse.json({ error: "You are already your own teammate." }, { status: 400 });
  const target = await getSql()`SELECT name FROM users WHERE id=${targetId}`;
  if (!target.length) return NextResponse.json({ error: "That person has not joined Ranked yet." }, { status: 404 });
  if (await rateLimited(`friend-request:${user.id}`, 30, 3600)) {
    return tooManyRequests("You've sent a lot of friend requests. Try again later.");
  }
  const upserted = await upsertFriendship(user.id, targetId);
  if (!upserted) return NextResponse.json({ error: "Could not send that request." }, { status: 500 });
  if (upserted.status === "blocked" && upserted.blockedBy === user.id) {
    return NextResponse.json({ error: "Unblock this player before sending them a friend request." }, { status: 409 });
  }
  // Otherwise the response deliberately looks the same whether or not the
  // other player has blocked this one — a blocked sender isn't told.
  const friendship = {
    id: upserted.id,
    status: upserted.status === "blocked" ? "pending" : upserted.status,
  };
  // Only a request that actually changed something counts: re-sending one
  // that's already pending must not rack up challenge progress.
  if (upserted.status === "pending" && upserted.previousStatus !== "pending") {
    await addChallengeProgress(user.id, "send_friend_request", 1);
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
  const body = await request.json().catch(() => null);
  const friendshipId = typeof body?.friendshipId === "string" ? body.friendshipId : "";
  const action = typeof body?.action === "string" ? body.action : "";
  if (!friendshipId || !["accept", "decline", "block", "unfriend", "unblock"].includes(action)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (action === "block") {
    // blocked_by records who placed the block, so only they can see or lift
    // it. A row that's already blocked can't be re-blocked by the other side
    // to take that over.
    const rows = await getSql()`UPDATE friendships SET status='blocked', blocked_by=${user.id}, updated_at=NOW()
      WHERE id=${friendshipId} AND (requester_id=${user.id} OR addressee_id=${user.id}) AND status<>'blocked'
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
    // blocked_by IS NULL covers blocks placed before that column existed and
    // that the migration couldn't attribute from the audit log.
    const rows = await getSql()`DELETE FROM friendships
      WHERE id=${friendshipId} AND (requester_id=${user.id} OR addressee_id=${user.id}) AND status='blocked'
        AND (blocked_by=${user.id} OR blocked_by IS NULL)
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

