export const hackClubScopes =
  "email name birthdate address verification_status slack_id";

export type HackClubAddress = {
  id: string;
  first_name?: string;
  last_name?: string;
  line_1?: string;
  line_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  country?: string;
  primary?: boolean;
};

export type HackClubIdentity = {
  id?: string;
  first_name?: string;
  last_name?: string;
  primary_email?: string;
  email?: string;
  slack_id?: string;
  verification_status?: string;
  picture?: string;
  birthday?: string;
  birthdate?: string;
  addresses?: HackClubAddress[];
};

function authBaseUrl() {
  return process.env.HCAUTH_BASE_URL ?? "https://auth.hackclub.com";
}

export function hackClubAuthorizationUrl(state: string, redirectUri: string) {
  const clientId = process.env.AUTH_CLIENTID;
  if (!clientId) throw new Error("AUTH_CLIENTID is required.");
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: process.env.AUTH_REDIRECT_URI ?? redirectUri,
    response_type: "code",
    scope: hackClubScopes,
    state,
  });
  return `${authBaseUrl()}/oauth/authorize?${params}`;
}

export async function exchangeHackClubCode(code: string, redirectUri: string) {
  const clientId = process.env.AUTH_CLIENTID;
  const clientSecret = process.env.AUTH_CLIENTSECRET;
  if (!clientId || !clientSecret) throw new Error("AUTH_CLIENTID and AUTH_CLIENTSECRET are required.");
  const response = await fetch(`${authBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: process.env.AUTH_REDIRECT_URI ?? redirectUri,
      code,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) throw new Error(`Hack Club token exchange failed (${response.status}).`);
  const token = await response.json() as { access_token: string };
  const meResponse = await fetch(`${authBaseUrl()}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!meResponse.ok) throw new Error(`Hack Club profile request failed (${meResponse.status}).`);
  const me = await meResponse.json() as { identity: HackClubIdentity };
  return me.identity;
}
