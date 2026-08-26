export const hackatimeScopes =
  process.env.HACKATIME_OAUTH_SCOPE ?? "profile read";

export type HackatimeProfile = {
  id: string | number;
  emails?: string[];
  slack_id?: string | null;
  github_username?: string | null;
  trust_factor?: {
    trust_level?: string;
    trust_value?: number;
  } | null;
};

export type HackatimeConnectionResult = {
  accessToken: string;
  scope: string;
  expiresAt: Date | null;
  profile: HackatimeProfile;
};

function baseUrl() {
  return (process.env.HACKATIME_BASE_URL ?? "https://hackatime.hackclub.com").replace(/\/$/, "");
}

function clientCredentials() {
  const clientId = process.env.HACKATIME_CLIENT_ID;
  const clientSecret = process.env.HACKATIME_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("HACKATIME_CLIENT_ID and HACKATIME_CLIENT_SECRET are required.");
  }
  return { clientId, clientSecret };
}

export function hackatimeAuthorizationUrl(state: string, redirectUri: string) {
  const { clientId } = clientCredentials();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: process.env.HACKATIME_REDIRECT_URI ?? redirectUri,
    response_type: "code",
    scope: hackatimeScopes,
    state,
  });
  return `${baseUrl()}/oauth/authorize?${params}`;
}

export async function exchangeHackatimeCode(
  code: string,
  redirectUri: string,
): Promise<HackatimeConnectionResult> {
  const { clientId, clientSecret } = clientCredentials();
  const tokenResponse = await fetch(`${baseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: process.env.HACKATIME_REDIRECT_URI ?? redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenResponse.ok) {
    throw new Error(`Hackatime token exchange failed (${tokenResponse.status}).`);
  }
  const token = (await tokenResponse.json()) as {
    access_token?: string;
    expires_in?: number;
    created_at?: number;
    scope?: string;
  };
  if (!token.access_token) throw new Error("Hackatime did not return an access token.");

  const profileResponse = await fetch(`${baseUrl()}/api/v1/authenticated/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!profileResponse.ok) {
    throw new Error(`Hackatime profile request failed (${profileResponse.status}).`);
  }
  const profile = (await profileResponse.json()) as HackatimeProfile;
  if (profile.id === undefined || profile.id === null) {
    throw new Error("Hackatime did not return a user ID.");
  }

  const createdAt = token.created_at ?? Math.floor(Date.now() / 1000);
  const expiresAt = token.expires_in
    ? new Date((createdAt + token.expires_in) * 1000)
    : null;
  return {
    accessToken: token.access_token,
    scope: token.scope ?? hackatimeScopes,
    expiresAt,
    profile,
  };
}

export async function revokeHackatimeToken(token: string) {
  const { clientId, clientSecret } = clientCredentials();
  const response = await fetch(`${baseUrl()}/oauth/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  if (!response.ok) {
    throw new Error(`Hackatime token revocation failed (${response.status}).`);
  }
}

export async function getHackatimeApiKey(accessToken: string) {
  const response = await fetch(`${baseUrl()}/api/v1/authenticated/api_keys`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Hackatime API key request failed (${response.status}).`);
  }
  const result = (await response.json()) as { token?: string };
  if (!result.token) throw new Error("Hackatime did not return an API key.");
  return result.token;
}

export async function sendHackatimeHeartbeat(
  apiKey: string,
  heartbeat: {
    entity: string;
    type: "file";
    time: number;
    project: string;
    branch: string;
    language: string;
    is_write: boolean;
    lineno: number;
    cursorpos: number;
    lines: number;
    category: "coding";
    editor: "Monaco";
    machine: "Hack Club Ranked Web IDE";
    operating_system: "Web";
    user_agent: string;
  },
) {
  const response = await fetch(
    `${baseUrl()}/api/hackatime/v1/users/current/heartbeats`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([heartbeat]),
    },
  );
  if (!response.ok) {
    const error = new Error(`Hackatime heartbeat failed (${response.status}).`);
    Object.assign(error, { status: response.status });
    throw error;
  }
}
