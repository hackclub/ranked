// Tailwind's browser ("Play CDN") build, pinned to one exact release and kept
// in this repository at app/lib/vendor/ rather than loaded from Tailwind's
// CDN. That CDN serves no CORS headers, so a page can't pin it with a
// Subresource Integrity hash — the only way to guarantee which script every
// player's site runs is to ship the script ourselves.
//
// These two names are all the client needs; the script itself is only ever
// imported by server code (see tailwind-source.ts).

// The file name a published build references, relative to its own folder.
// publishWebsite commits the script next to the build's pages.
export const TAILWIND_FILE_NAME = "tailwindcss-3.4.17.js";

// Where the live preview loads the same script from: a route of this app.
export const TAILWIND_PREVIEW_PATH = `/vendor/${TAILWIND_FILE_NAME}`;
