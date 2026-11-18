import { NextRequest, NextResponse } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/app/lib/session";
import { currentUser } from "@/app/lib/current-user";
import { isAdmin } from "@/app/lib/admin";

export async function GET(request: NextRequest) {
  const session = await decryptSession(request.cookies.get(SESSION_COOKIE)?.value);
  const user = session?.user ? await currentUser(request) : null;
  return NextResponse.json({
    // The admin allowlist lives in server-side configuration, so the client is
    // told only whether *this* account is on it. It decides which controls are
    // shown; every admin route still checks the allowlist itself.
    user: user ? { ...user, isAdmin: isAdmin(user.email) } : null,
    github: session?.github
      ? { login: session.github.login, avatarUrl: session.github.avatarUrl }
      : null,
    hackatime: user?.hackatimeConnected
      ? { id: user.hackatimeUserId, email: user.hackatimeEmail }
      : null,
  });
}
