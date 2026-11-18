import { NextRequest, NextResponse } from "next/server";
import { currentUser } from "@/app/lib/current-user";
import { rateLimited, tooManyRequests } from "@/app/lib/rate-limit";
import { getSql } from "@/db";
import { AVATAR_PARTS, isOwnedOrStarterValue, normalizeAvatar } from "@/app/lib/avatar";
import { STARTING_ELO, type Experience } from "@/app/lib/rank";

const experiences = new Set(["beginner", "intermediate", "expert"]);
const SLACK_USERNAME_PATTERN = /^[a-z0-9._-]{1,80}$/;

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export async function GET(request: NextRequest) {
  const user = await currentUser(request);
  return user ? NextResponse.json({ user }) : NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: NextRequest) {
  const user = await currentUser(request);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // Username changes are checked against every other player's, so an
  // unmetered loop here doubles as a way to enumerate which names are taken.
  if (await rateLimited(`profile:${user.id}`, 120, 600)) return tooManyRequests();
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
  try {
    const rows = await getSql()`
      UPDATE users SET experience = ${experience}::experience_level, avatar = ${JSON.stringify(avatar)}::jsonb,
        slack_username = ${slackUsername}, elo = COALESCE(${startingElo}, elo), updated_at = NOW()
      WHERE id = ${user.id}
      RETURNING experience, avatar, slack_username AS "slackUsername", elo
    `;
    return NextResponse.json({ user: rows[0] });
  } catch (error) {
    // The check above can lose a race with another player claiming the same
    // name; the database's unique constraint is what actually decides it.
    if (isUniqueViolation(error)) {
      return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
    }
    throw error;
  }
}
