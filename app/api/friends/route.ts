import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { addChallengeProgress } from "@/app/lib/progression";
import { getSql } from "@/db";

async function findBySlackUsername(username: string) {
  const normalized = username.replace(/^@/, "").trim().toLowerCase();
  const local = await getSql()`SELECT id FROM users WHERE LOWER(slack_id)=${normalized} OR LOWER(name)=${normalized} LIMIT 1`;
  if (local[0]) return String(local[0].id);
  if (!process.env.SLACK_BOT_TOKEN) return null;
  const response = await fetch("https://slack.com/api/users.list?limit=200", { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
  const data = await response.json() as { ok: boolean; members?: Array<{ id: string; name: string; profile?: { display_name?: string } }> };
  const member = data.members?.find(item => item.name.toLowerCase() === normalized || item.profile?.display_name?.toLowerCase() === normalized);
  if (!member) return null;
  const matched = await getSql()`SELECT id FROM users WHERE slack_id=${member.id} LIMIT 1`;
  return matched[0] ? String(matched[0].id) : null;
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
  const targetId = body.targetUserId || (body.slackUsername ? await findBySlackUsername(body.slackUsername) : null);
  if (!targetId) return NextResponse.json({ error: "That Slack user has not joined Ranked yet." }, { status: 404 });
  if (targetId === user.id) return NextResponse.json({ error: "You are already your own teammate." }, { status: 400 });
  const pairKey = [user.id, targetId].sort().join(":");
  const rows = await getSql()`INSERT INTO friendships (id,requester_id,addressee_id,pair_key,status)
    VALUES (${crypto.randomUUID()},${user.id},${targetId},${pairKey},'pending')
    ON CONFLICT (pair_key) DO UPDATE SET requester_id=EXCLUDED.requester_id, addressee_id=EXCLUDED.addressee_id,
      status=CASE WHEN friendships.status='declined' THEN 'pending'::friendship_status ELSE friendships.status END, updated_at=NOW()
    RETURNING id,status`;
  return NextResponse.json({ friendship: rows[0] });
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

