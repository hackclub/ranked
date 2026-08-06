import { NextRequest, NextResponse } from "next/server";
import { appUrl } from "@/app/lib/urls";

export async function POST(request: NextRequest) {
  const wantsJson = request.headers.get("accept")?.includes("application/json");
  const response = wantsJson
    ? NextResponse.json({ ok: true })
    : NextResponse.redirect(appUrl("/", request), 303);

  const cookieNames = new Set([
    "ranked_session",
    "ranked_hca_state",
    "ranked_github_state",
    "ranked_github_verifier",
    "ranked_hackatime_state",
    ...request.cookies.getAll().map(cookie => cookie.name),
  ]);
  for (const name of cookieNames) {
    response.cookies.set(name, "", {
      expires: new Date(0),
      maxAge: 0,
      path: "/",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  }
  response.headers.set("Clear-Site-Data", '"cache", "cookies", "storage"');
  return response;
}
