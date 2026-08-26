import { NextRequest, NextResponse } from "next/server";
import { encryptCredential } from "@/app/lib/credential";
import {
  exchangeHackatimeCode,
  getHackatimeApiKey,
} from "@/app/lib/hackatime";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";
import { getSql } from "@/db";

function finish(request: NextRequest, status: string) {
  const response = NextResponse.redirect(appUrl(`/?hackatime=${status}`, request));
  response.cookies.delete("ranked_hackatime_state");
  return response;
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const error = request.nextUrl.searchParams.get("error");
  const expectedState = request.cookies.get("ranked_hackatime_state")?.value;
  const session = await decryptSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (error || !code || !state || state !== expectedState || !session?.user) {
    return finish(request, "failed");
  }

  try {
    const redirectUri = appUrl("/api/auth/hackatime/callback", request).toString();
    const connection = await exchangeHackatimeCode(code, redirectUri);
    const emails = (connection.profile.emails ?? []).map((email) =>
      email.trim().toLowerCase(),
    );
    const slackMatches = Boolean(
      session.user.slackId &&
        connection.profile.slack_id &&
        session.user.slackId === connection.profile.slack_id,
    );
    const emailMatches = emails.includes(session.user.email.toLowerCase());
    if (!slackMatches && !emailMatches) {
      return finish(request, "identity_mismatch");
    }

    const encryptedToken = await encryptCredential(connection.accessToken);
    const encryptedApiKey = await encryptCredential(
      await getHackatimeApiKey(connection.accessToken),
    );
    await getSql()`
      INSERT INTO hackatime_connections (
        user_id, hackatime_user_id, access_token_encrypted, api_key_encrypted, scopes,
        primary_email, slack_id, github_username, expires_at
      ) VALUES (
        ${session.user.id}, ${String(connection.profile.id)}, ${encryptedToken}, ${encryptedApiKey},
        ${connection.scope}, ${emails[0] ?? null},
        ${connection.profile.slack_id ?? null},
        ${connection.profile.github_username ?? null}, ${connection.expiresAt}
      )
      ON CONFLICT (user_id) DO UPDATE SET
        hackatime_user_id = EXCLUDED.hackatime_user_id,
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        api_key_encrypted = EXCLUDED.api_key_encrypted,
        scopes = EXCLUDED.scopes,
        primary_email = EXCLUDED.primary_email,
        slack_id = EXCLUDED.slack_id,
        github_username = EXCLUDED.github_username,
        expires_at = EXCLUDED.expires_at,
        last_heartbeat_at = NULL,
        updated_at = NOW()
    `;
    return finish(request, "connected");
  } catch (error) {
    console.error(error);
    return finish(request, "failed");
  }
}
