import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { getSql } from "@/db";
import { AVATAR_PARTS, isOwnedOrStarterValue, normalizeAvatar } from "@/app/lib/avatar";
import { STARTING_ELO, type Experience } from "@/app/lib/rank";

const experiences = new Set(["beginner", "intermediate", "expert"]);
const SLACK_USERNAME_PATTERN = /^[a-z0-9._-]{1,80}$/;

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  return user ? NextResponse.json({ user }) : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json();
  const experience = experiences.has(body.experience) ? body.experience : user.experience;
  // Placement (choosing a starting bracket) only ever happens once, the
  // first time onboarding sets an experience level — a starting ELO applied
  // here would otherwise silently reset progress if this endpoint were ever
  // called again with the same field.
  const isFirstPlacement = !user.experience && experiences.has(body.experience);
  const startingElo = isFirstPlacement ? STARTING_ELO[experience as Experience] : null;
  const wantsAvatarChange = Boolean(body.avatar && typeof body.avatar === "object");
  const avatar = normalizeAvatar(wantsAvatarChange ? body.avatar : user.avatar);

  let slackUsername = user.slackUsername;
  if (typeof body.slackUsername === "string") {
    const normalized = body.slackUsername.trim().replace(/^@/, "").toLowerCase();
    if (!SLACK_USERNAME_PATTERN.test(normalized)) {
      return NextResponse.json(
        { error: "Usernames are 1-80 characters: letters, numbers, periods, underscores, or hyphens." },
        { status: 400 },
      );
    }
    if (normalized !== user.slackUsername) {
      const taken = await getSql()`SELECT 1 FROM users WHERE slack_username = ${normalized} AND id <> ${user.id}`;
      if (taken.length) {
        return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
      }
    }
    slackUsername = normalized;
  }

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
    UPDATE users SET experience = ${experience}::experience_level, avatar = ${JSON.stringify(avatar)}::jsonb,
      slack_username = ${slackUsername}, elo = COALESCE(${startingElo}, elo), updated_at = NOW()
    WHERE id = ${user.id}
    RETURNING experience, avatar, slack_username AS "slackUsername", elo
  `;
  return NextResponse.json({ user: rows[0] });
}
