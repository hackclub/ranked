import { NextRequest, NextResponse } from "next/server";
import { exchangeHackClubCode } from "@/app/lib/hackclub";
import { decryptSession, encryptSession, SESSION_COOKIE, sessionCookieOptions } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";
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
    await getSql()`
      INSERT INTO users (id, email, name, slack_id, verification_status)
      VALUES (${userId}, ${email}, ${name}, ${identity.slack_id ?? null}, ${identity.verification_status ?? null})
      ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, name = EXCLUDED.name,
        slack_id = EXCLUDED.slack_id, verification_status = EXCLUDED.verification_status, updated_at = NOW()
    `;
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
