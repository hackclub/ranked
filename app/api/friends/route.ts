import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { getSql } from "@/db";

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
  return NextResponse.json({ friendship: await upsertFriendship(user.id, targetId) });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { friendshipId, action } = await request.json();
  const status = action === "accept" ? "accepted" : "declined";
  const rows = await getSql()`UPDATE friendships SET status=${status}::friendship_status, updated_at=NOW()
    WHERE id=${friendshipId} AND addressee_id=${user.id} AND status='pending' RETURNING requester_id AS "requesterId"`;
  if (!rows.length) return NextResponse.json({ error: "Friend request not found" }, { status: 404 });
  if (status === "accepted") {
    await Promise.all([addChallengeProgress(user.id, "add_friends", 1), addChallengeProgress(String(rows[0].requesterId), "add_friends", 1)]);
  }
  return NextResponse.json({ ok: true, status });
}

