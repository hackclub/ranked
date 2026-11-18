import type { NextConfig } from "next";

// Security headers are set here, by the app itself, so every deployment gets
// them — not only one that happens to sit behind the vercel.json in this
// repository. vercel.json repeats the same values because on Vercel static
// files are served from the CDN without ever reaching the app;
// tests/security-headers.test.mjs keeps the two from drifting apart.
//
// There is deliberately no script-src here. A player's build is previewed in
// srcdoc iframes, and a srcdoc document inherits the Content-Security-Policy
// of the page that embeds it — so any limit on scripts, styles or images for
// the app would also be imposed on every website players write. Isolation for
// those frames comes from their sandbox attribute instead (see
// tests/preview-sandbox.test.mjs).
const appHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'" },
  { key: "Permissions-Policy", value: "geolocation=(), payment=(), usb=(), display-capture=()" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
];

// The recording review page shows private footage: it must never be framed,
// cached, indexed, or leak its URL in a Referer header.
const recordingReviewHeaders = [
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'none'; object-src 'none'" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), display-capture=()" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      // Order matters. More than one rule can match a path, and for a header
      // set by several of them the first rule listed is the one that is sent,
      // so the stricter recording-review rule has to come before the
      // catch-all. ("/:path*" does not match the bare "/", hence its own rule.)
      { source: "/reviewer/recordings", headers: recordingReviewHeaders },
      { source: "/", headers: appHeaders },
      { source: "/:path*", headers: appHeaders },
    ];
  },
};

export default nextConfig;
