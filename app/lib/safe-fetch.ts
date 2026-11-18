import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

// Addresses this server must never be talked into requesting: loopback,
// private networks, link-local (which includes cloud metadata endpoints),
// carrier-grade NAT, and their IPv6 equivalents.
const PRIVATE_ADDRESSES = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 3],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 127],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  PRIVATE_ADDRESSES.addSubnet(network, prefix, "ipv6");
}

function isPrivateAddress(address: string) {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return PRIVATE_ADDRESSES.check(mapped[1], "ipv4");
  return PRIVATE_ADDRESSES.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");
}

// http is allowed alongside https because GitHub Pages redirects to a custom
// domain over plain http when its owner has not switched on "Enforce HTTPS".
// What matters here is where the request goes, not how it is encrypted.
//
// Returns the one address the request is then made to, or null if the URL is
// not a public web address.
async function resolvePublicAddress(url: URL): Promise<LookupAddress | null> {
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  // Published sites live on real domain names: an IP literal or a bare,
  // dotless hostname is never one.
  if (isIP(hostname) || !hostname.includes(".")) return null;
  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) return null;
    return addresses[0];
  } catch {
    return null;
  }
}

// One GET to `url`, connecting to `pinned` and nowhere else. Left to itself
// the socket would resolve the hostname a second time, and a domain that
// answers with a public address for the check above and a private one a moment
// later (DNS rebinding) would be connected to unchecked. Handing the socket
// the address that was just vetted closes that gap. The hostname is still what
// TLS verifies the certificate against and what goes in the Host header.
function requestPinned(url: URL, pinned: LookupAddress, signal: AbortSignal) {
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) callback(null, [pinned]);
    else callback(null, pinned.address, pinned.family);
  };
  return new Promise<{ status: number; location: string | null }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "GET",
        // No connection pooling: every request gets a fresh socket to the
        // pinned address, and the socket is closed afterwards. A pooled
        // keep-alive connection reset by the edge is also what used to show
        // up client-side as an indefinitely stuck "deploying" (ECONNRESET).
        agent: false,
        headers: { Accept: "*/*", Connection: "close", "User-Agent": "node" },
        lookup: pinnedLookup,
        signal,
      },
      (response) => {
        const location = response.headers.location ?? null;
        // Only the status line and headers matter; the body is never read.
        response.destroy();
        resolve({ status: response.statusCode ?? 0, location });
      },
    );
    request.on("error", reject);
    request.end();
  });
}

// Reports whether a published page is reachable. Redirects are followed by
// hand (a GitHub Pages site can legitimately redirect to its owner's custom
// domain) and every hop has to resolve to a public web address, so neither a
// redirect nor a domain pointed at an internal address can be used to make
// this server request something on a private network.
export async function publicPageIsLive(startUrl: string, timeoutMs = 8_000) {
  const signal = AbortSignal.timeout(timeoutMs);
  let url: URL;
  try {
    url = new URL(startUrl);
  } catch {
    return false;
  }
  for (let hop = 0; hop < 4; hop += 1) {
    const pinned = await resolvePublicAddress(url);
    if (!pinned) return false;
    const { status, location } = await requestPinned(url, pinned, signal);
    if (status < 300 || status >= 400) return status >= 200 && status < 300;
    if (!location) return false;
    try {
      url = new URL(location, url);
    } catch {
      return false;
    }
  }
  return false;
}
