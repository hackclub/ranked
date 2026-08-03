import { NextRequest, NextResponse } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { currentUser } from "@/app/lib/current-user";

export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  const user = session?.user ? await currentUser(request) : null;
  return NextResponse.json({ user, github: session?.github ? { login: session.github.login, avatarUrl: session.github.avatarUrl } : null });
}
