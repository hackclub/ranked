import { cookies } from "next/headers";

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
};

export type RankedSession = {
  user?: RankedUser;
  github?: GitHubConnection;
  exp: number;
};

function sessionSecret() {
  const secret = process.env.AUTH_SESSION_SECRET;
  if (!secret) throw new Error("AUTH_SESSION_SECRET is required.");
  return secret;
}

function base64url(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64url(value: string) {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

async function encryptionKey() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionSecret()));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSession(session: Omit<RankedSession, "exp"> & { exp?: number }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: RankedSession = {
    ...session,
    exp: session.exp ?? Math.floor(Date.now() / 1000) + SESSION_MAX_AGE,
  };
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}

export async function decryptSession(value: string | undefined): Promise<RankedSession | null> {
  if (!value) return null;
  const [iv, encrypted] = value.split(".");
  if (!iv || !encrypted) return null;
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) },
      await encryptionKey(),
      fromBase64url(encrypted),
    );
    const session = JSON.parse(new TextDecoder().decode(decrypted)) as RankedSession;
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
