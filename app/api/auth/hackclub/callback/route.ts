import { NextRequest, NextResponse } from "next/server";
import { exchangeHackClubCode } from "@/app/lib/hackclub";
import { fetchSlackUsername } from "@/app/lib/slack";
import { randomStarterAvatar } from "@/app/lib/avatar";
import {
  encryptHackClubProfile,
  profileFromIdentity,
} from "@/app/lib/hack-club-profile";
import { decryptSession, encryptSession, SESSION_COOKIE, sessionCookieOptions } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";
import { logAudit } from "@/app/lib/audit";
import { getSql } from "@/db";

// A Slack display name is free text, so it's held to the same rules as a
// username a player types in themselves (see PATCH /api/profile): lowercase
// letters, numbers, periods, underscores and hyphens, and — checked in the
// INSERT below — not already taken. Anything else is dropped, which sends the
// player to pick one in onboarding instead of letting a display name
// impersonate another player's handle.
const SLACK_USERNAME_PATTERN = /^[a-z0-9._-]{1,80}$/;

function normalizeSlackUsername(value: string | null) {
  if (!value) return null;
  const normalized = value.trim().replace(/^@/, "").toLowerCase().replace(/\s+/g, "-");
  return SLACK_USERNAME_PATTERN.test(normalized) ? normalized : null;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  if (!code || !state || state !== request.cookies.get("ranked_hca_state")?.value) return NextResponse.redirect(appUrl("/?auth=failed", request));
  try {
    const redirectUri = appUrl("/api/auth/hackclub/callback", request).toString();
    const identity = await exchangeHackClubCode(code, redirectUri);
    const email = identity.primary_email ?? identity.email;
    if (!email) throw new Error("Hack Club Auth did not return an email.");
    const current = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
    const name = [identity.first_name, identity.last_name].filter(Boolean).join(" ") || email.split("@")[0];
    // The account id is shown to other players (friend lists, match rosters,
    // profile URLs), so it must be Hack Club Auth's opaque id and nothing
    // else. Falling back to the email here would publish it — and would
    // create a second, separate account for the same person.
    const userId = typeof identity.id === "string" ? identity.id.trim() : "";
    if (!userId || userId.includes("@")) throw new Error("Hack Club Auth did not return an account id.");
    const encryptedProfile = await encryptHackClubProfile(
      profileFromIdentity(identity, email),
    );
    // A random starter avatar is only ever meaningful for a brand-new row —
    // it's in the VALUES tuple but deliberately left out of DO UPDATE SET,
    // so an existing player's already-chosen look is never touched on
    // subsequent logins (same reasoning as avatar_url's COALESCE below).
    const newAccountAvatar = JSON.stringify(randomStarterAvatar());
    // Best-effort — a failed or empty lookup leaves slack_username untouched
    // (COALESCE below) rather than clobbering a value the player already set
    // themselves in onboarding after an earlier attempt came back empty.
    const fetchedSlackUsername = normalizeSlackUsername(
      identity.slack_id ? await fetchSlackUsername(identity.slack_id) : null,
    );
    const upsertUser = (slackUsername: string | null) => getSql()`
      INSERT INTO users (id, email, name, slack_id, slack_username, verification_status, avatar_url, avatar, last_seen_at)
      VALUES (${userId}, ${email}, ${name}, ${identity.slack_id ?? null},
        (SELECT ${slackUsername}::text WHERE NOT EXISTS (
          SELECT 1 FROM users taken WHERE taken.slack_username=${slackUsername} AND taken.id<>${userId}
        )),
        ${identity.verification_status ?? null}, ${identity.picture ?? null}, ${newAccountAvatar}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
        slack_id = EXCLUDED.slack_id, slack_username = COALESCE(users.slack_username, EXCLUDED.slack_username),
        verification_status = EXCLUDED.verification_status,
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), last_seen_at = NOW(), updated_at = NOW()
    `;
    try {
      await upsertUser(fetchedSlackUsername);
    } catch (error) {
      // Two sign-ins racing for the same Slack-derived username: the unique
      // constraint rejects the second. Signing in matters more than the
      // suggested name, so retry without it and let onboarding ask.
      const usernameTaken =
        typeof error === "object" && error !== null && "code" in error && error.code === "23505" &&
        String((error as { constraint?: unknown }).constraint ?? "").includes("slack_username");
      if (!usernameTaken) throw error;
      await upsertUser(null);
    }
    await getSql()`
      INSERT INTO hack_club_profiles (user_id, profile_encrypted)
      VALUES (${userId}, ${encryptedProfile})
      ON CONFLICT (user_id) DO UPDATE SET
        profile_encrypted=EXCLUDED.profile_encrypted, updated_at=NOW()
    `;
    await logAudit({
      actor: { id: userId, name, email },
      action: "auth.login",
      summary: `${name} signed in via Hack Club OAuth`,
      targetType: "user",
      targetId: userId,
    });

    const response = NextResponse.redirect(appUrl("/?auth=connected", request));
    response.cookies.set(SESSION_COOKIE, await encryptSession({
      github: current?.github,
      user: { id: userId, name, email, slackId: identity.slack_id ?? null, verificationStatus: identity.verification_status ?? null },
    }), sessionCookieOptions());
    response.cookies.delete("ranked_hca_state");
    return response;
  } catch (error) {
    console.error(error);
    return NextResponse.redirect(appUrl("/?auth=failed", request));
  }
}
