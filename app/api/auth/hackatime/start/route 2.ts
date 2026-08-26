import { NextRequest, NextResponse } from "next/server";
import { hackatimeAuthorizationUrl } from "@/app/lib/hackatime";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

export async function GET(request: NextRequest) {
  const session = await decryptSession(
    request.cookies.get(SESSION_COOKIE)?.value,
  );
  if (!session?.user) {
    return NextResponse.redirect(appUrl("/api/auth/hackclub/start", request));
  }
  const state = Buffer.from(
    crypto.getRandomValues(new Uint8Array(24)),
  ).toString("base64url");
  const redirectUri = appUrl("/api/auth/hackatime/callback", request).toString();
  const response = NextResponse.redirect(
    hackatimeAuthorizationUrl(state, redirectUri),
  );
  response.cookies.set("ranked_hackatime_state", state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return response;
}
