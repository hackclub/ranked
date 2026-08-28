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
    const userId = identity.id ?? email;
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
    const fetchedSlackUsername = identity.slack_id
      ? await fetchSlackUsername(identity.slack_id)
      : null;
    await getSql()`
      INSERT INTO users (id, email, name, slack_id, slack_username, verification_status, avatar_url, avatar, last_seen_at)
      VALUES (${userId}, ${email}, ${name}, ${identity.slack_id ?? null}, ${fetchedSlackUsername}, ${identity.verification_status ?? null}, ${identity.picture ?? null}, ${newAccountAvatar}::jsonb, NOW())
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
        slack_id = EXCLUDED.slack_id, slack_username = COALESCE(users.slack_username, EXCLUDED.slack_username),
        verification_status = EXCLUDED.verification_status,
        avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url), last_seen_at = NOW(), updated_at = NOW()
    `;
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
