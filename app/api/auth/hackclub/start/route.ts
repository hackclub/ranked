import { NextRequest, NextResponse } from "next/server";
import { hackClubAuthorizationUrl } from "@/app/lib/hackclub";
import { appUrl } from "@/app/lib/urls";

export async function GET(request: NextRequest) {
  const state = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64url");
  const redirectUri = appUrl("/api/auth/hackclub/callback", request).toString();
  const response = NextResponse.redirect(hackClubAuthorizationUrl(state, redirectUri));
  response.cookies.set("ranked_hca_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 600 });
  return response;
}
