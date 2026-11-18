import { cookies } from "next/headers";
import { aesGcmDecrypt, aesGcmEncrypt, aesGcmKey, requireSecret } from "@/app/lib/aes-gcm";

export const SESSION_COOKIE = "ranked_session";
const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export type RankedUser = {
  id: string;
  name: string;
  email: string;
  slackId: string | null;
  verificationStatus: string | null;
};

export type GitHubConnection = {
  login: string;
  accessToken: string;
  avatarUrl: string | null;
  refreshToken?: string | null;
  accessTokenExpiresAt?: number | null;
  refreshTokenExpiresAt?: number | null;
};

export type RankedSession = {
  user?: RankedUser;
  github?: GitHubConnection;
  exp: number;
};

async function encryptionKey() {
  return aesGcmKey(requireSecret("AUTH_SESSION_SECRET"));
}

export async function encryptSession(session: Omit<RankedSession, "exp"> & { exp?: number }) {
  const payload: RankedSession = {
    ...session,
    exp: session.exp ?? Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  return aesGcmEncrypt(await encryptionKey(), JSON.stringify(payload));
}

export async function decryptSession(value: string | undefined): Promise<RankedSession | null> {
  if (!value) return null;
  try {
    const decrypted = await aesGcmDecrypt(await encryptionKey(), value, "session");
    const session = JSON.parse(decrypted) as RankedSession;
    if (!session.exp || session.exp < Math.floor(Date.now() / 1000)) return null;
    return session;
  } catch {
    return null;
  }
}

export async function getSession() {
  const cookieStore = await cookies();
  return decryptSession(cookieStore.get(SESSION_COOKIE)?.value);
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  };
}
