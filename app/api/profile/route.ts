import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";
import { normalizeAvatar } from "@/app/lib/avatar";

const experiences = new Set(["beginner", "intermediate", "expert"]);

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  return user ? NextResponse.json({ user }) : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const experience = experiences.has(body.experience) ? body.experience : user.experience;
  const avatar = normalizeAvatar(body.avatar && typeof body.avatar === "object" ? body.avatar : user.avatar);
  const rows = await getSql()`
    UPDATE users SET experience = ${experience}::experience_level, avatar = ${JSON.stringify(avatar)}::jsonb, updated_at = NOW()
    WHERE id = ${user.id}
    RETURNING experience, avatar
  `;
  return NextResponse.json({ user: rows[0] });
}
