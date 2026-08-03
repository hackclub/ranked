import type { NextRequest } from "next/server";

export function appOrigin(request: NextRequest) {
  return (process.env.APP_BASE_URL ?? request.nextUrl.origin).replace(/\/$/, "");
}

export function appUrl(path: string, request: NextRequest) {
  return new URL(path, `${appOrigin(request)}/`);
}
