import type { NextRequest } from "next/server";

export function appOrigin(request: NextRequest) {
  return (process.env.APP_BASE_URL ?? request.nextUrl.origin).replace(/\/$/, "");
}

export function appUrl(path: string, request: NextRequest) {
  return new URL(path, `${appOrigin(request)}/`);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// The session cookie is SameSite=Lax, which stops other *sites* from sending
// it on a POST — but every other *.hackclub.com app is the same site as this
// one, so Lax alone lets any of them (or an XSS on any of them) drive a
// signed-in player's account. Browsers attach Origin to every state-changing
// request, so a mutation whose Origin isn't this app is refused outright.
// Requests with neither header come from non-browser clients (scripts, tests),
// which can't be used for CSRF because they don't carry a victim's cookies.
export function isCrossSiteMutation(request: NextRequest) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      const configured = process.env.APP_BASE_URL;
      if (configured && new URL(configured).origin === origin) return false;
      // Whichever way the platform reports the host this request arrived on,
      // the page that sent it has to be on that same host.
      const hosts = [
        request.headers.get("x-forwarded-host")?.split(",")[0].trim(),
        request.headers.get("host")?.trim(),
        request.nextUrl.host,
      ];
      return !hosts.includes(new URL(origin).host);
    } catch {
      return true;
    }
  }
  const fetchSite = request.headers.get("sec-fetch-site");
  return Boolean(fetchSite && fetchSite !== "same-origin" && fetchSite !== "none");
}
