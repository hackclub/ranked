import { createHash, createHmac } from "node:crypto";

export type IceServer = { urls: string | string[]; username?: string; credential?: string };
export type IceConfiguration = {
  iceServers: IceServer[];
  // "relay" sends all call media through the TURN server, so players in a
  // call never learn each other's IP address. "all" allows direct
  // peer-to-peer connections, which do reveal it.
  iceTransportPolicy: "all" | "relay";
};

const PUBLIC_STUN: IceServer = {
  urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"],
};
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;

function ttlSeconds() {
  const configured = Math.floor(Number(process.env.TURN_CREDENTIAL_TTL_SECONDS));
  return Number.isFinite(configured) && configured >= 300 && configured <= 86_400
    ? configured
    : DEFAULT_TTL_SECONDS;
}

function turnUrls() {
  // NEXT_PUBLIC_TURN_URL is the name this setting had when it was shipped to
  // the browser. It is still read here, server-side only, so an existing
  // deployment keeps its TURN server without the value reaching the bundle.
  return (process.env.TURN_URLS || process.env.NEXT_PUBLIC_TURN_URL || "")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => /^turns?:/i.test(url));
}

// Cloudflare Realtime TURN: exchanges the long-lived key for credentials that
// expire on their own.
async function cloudflareIceServers(): Promise<IceServer[] | null> {
  const keyId = process.env.CLOUDFLARE_TURN_KEY_ID?.trim();
  const apiToken = process.env.CLOUDFLARE_TURN_API_TOKEN?.trim();
  if (!keyId || !apiToken) return null;
  const response = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: ttlSeconds() }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (!response.ok) throw new Error(`Cloudflare TURN credentials failed (${response.status}).`);
  const result = (await response.json()) as { iceServers?: IceServer[] };
  const servers = (result.iceServers ?? []).filter(
    (server) => server && (typeof server.urls === "string" || Array.isArray(server.urls)),
  );
  return servers.length ? servers : null;
}

// The shared-secret scheme coturn calls "use-auth-secret" (and most hosted
// TURN services support): the username carries its own expiry and the
// credential is an HMAC of it, so nothing long-lived ever leaves the server.
function sharedSecretIceServers(userId: string): IceServer[] | null {
  const secret = process.env.TURN_SHARED_SECRET;
  const urls = turnUrls();
  if (!secret || !urls.length) return null;
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds();
  // A hash rather than the account id itself: the username is visible to the
  // TURN operator and travels in the clear during the TURN handshake.
  const tag = createHash("sha256").update(userId).digest("hex").slice(0, 16);
  const username = `${expires}:${tag}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");
  return [{ urls, username, credential }];
}

// A single fixed username/password. Weaker than either option above — it
// can't expire — but it is only ever handed to a signed-in player who is in
// the match, never compiled into the public JavaScript bundle.
function staticIceServers(): IceServer[] | null {
  const urls = turnUrls();
  const username = process.env.TURN_USERNAME || process.env.NEXT_PUBLIC_TURN_USERNAME;
  const credential = process.env.TURN_CREDENTIAL || process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (!urls.length || !username || !credential) return null;
  return [{ urls, username, credential }];
}

export async function iceConfiguration(userId: string): Promise<IceConfiguration> {
  let turn: IceServer[] | null = null;
  try {
    turn = (await cloudflareIceServers()) ?? sharedSecretIceServers(userId) ?? staticIceServers();
  } catch (error) {
    console.error("TURN credentials unavailable", error);
  }
  // Relay-only is opt-in because every minute of every call then goes through
  // (and is billed by) the TURN server. Without a working TURN server there is
  // nothing to relay through, so it can never be forced on its own.
  const relayOnly = Boolean(turn) && process.env.TURN_RELAY_ONLY === "true";
  return {
    iceServers: relayOnly ? turn! : [PUBLIC_STUN, ...(turn ?? [])],
    iceTransportPolicy: relayOnly ? "relay" : "all",
  };
}
