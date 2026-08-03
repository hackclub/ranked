import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/app/lib/session";
import { appUrl } from "@/app/lib/urls";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(appUrl("/", request), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
