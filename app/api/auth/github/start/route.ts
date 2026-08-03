import { NextRequest, NextResponse } from "next/server";
import { githubAuthorizationUrl } from "@/app/lib/github";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

function randomValue(bytes = 32) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url"); }

export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (!session?.user) return NextResponse.redirect(appUrl("/api/auth/hackclub/start", request));
  const state = randomValue(24);
  const verifier = randomValue(48);
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(challengeBytes).toString("base64url");
  const redirectUri = appUrl("/api/auth/github/callback", request).toString();
  const response = NextResponse.redirect(githubAuthorizationUrl(state, challenge, redirectUri));
  const options = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 };
  response.cookies.set("ranked_github_state", state, options);
  response.cookies.set("ranked_github_verifier", verifier, options);
  return response;
}
