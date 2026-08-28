import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";
import { AVATAR_PARTS, isOwnedOrStarterValue, normalizeAvatar } from "@/app/lib/avatar";

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
  const wantsAvatarChange = Boolean(body.avatar && typeof body.avatar === "object");
  const avatar = normalizeAvatar(wantsAvatarChange ? body.avatar : user.avatar);

  // Full freedom while onboarding (experience isn't set yet) matches today's
  // behavior. Once onboarding is done, every part must be a free starter value
  // or something actually bought in the Shop — enforced here too, not just in
  // the UI, since this endpoint is reachable directly.
  if (wantsAvatarChange && user.experience) {
    const ownedRows = await getSql()`SELECT item_id AS "itemId" FROM shop_orders WHERE user_id=${user.id}`;
    const owned = new Set(ownedRows.map((row) => row.itemId as string));
    const disallowed = AVATAR_PARTS.some((part) => !isOwnedOrStarterValue(part, avatar[part], owned));
    if (disallowed) {
      return NextResponse.json(
        { error: "Buy that look in the Shop before wearing it in the Wardrobe." },
        { status: 403 },
      );
    }
  }
  const rows = await getSql()`
    UPDATE users SET experience = ${experience}::experience_level, avatar = ${JSON.stringify(avatar)}::jsonb, updated_at = NOW()
    WHERE id = ${user.id}
    RETURNING experience, avatar
  `;
  return NextResponse.json({ user: rows[0] });
}
