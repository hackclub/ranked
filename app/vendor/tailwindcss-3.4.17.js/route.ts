import { TAILWIND_SOURCE } from "@/app/lib/tailwind-source";

// Serves the pinned Tailwind browser build to the live preview. The preview
// frame is sandboxed with an opaque origin, so this is a cross-origin script
// load from its point of view — hence the explicit resource policy. The file
// never changes for a given version, so it can be cached indefinitely.
export function GET() {
  return new Response(TAILWIND_SOURCE, {
    headers: {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
