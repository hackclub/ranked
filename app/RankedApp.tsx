"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { CollaborativeEditor } from "./realtime/CollaborativeEditor";
import { StreamVideo } from "./realtime/StreamVideo";
import {
  useCodeRoom,
  useRealtimeRoom,
  type PeerVideoLost,
} from "./realtime/useRealtimeRoom";
import {
  supportedRecordingMimeType,
  useMatchRecording,
} from "./realtime/useMatchRecording";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { isAdmin } from "./lib/admin";
import { recordingConsentCopy } from "./lib/recording-policy";
import { AvatarCustomizer, ScribbleAvatar } from "./components/GoofyGuyAvatar";
import {
  DEFAULT_AVATAR,
  SHOP_CATALOG,
  avatarAccent,
  normalizeAvatar,
  randomStarterAvatar,
  type AvatarConfig,
  type AvatarShopItem,
  type ResolvedAvatarConfig,
  type ShopItem,
} from "./lib/avatar";

type Screen =
  | "home"
  | "lobby"
  | "match"
  | "vote"
  | "leaderboard"
  | "shop"
  | "wardrobe"
  | "admin";
type Mode = "solo" | "duo";
type Experience = "beginner" | "intermediate" | "expert";
type AuthState = {
  user: {
    id: string;
    name: string;
    email: string;
    slackId: string | null;
    verificationStatus: string | null;
    experience: Experience | null;
    elo: number;
    matchesPlayed: number;
    codingSeconds: number;
    hBucks: number;
    avatar: AvatarConfig;
  } | null;
  github: { login: string; avatarUrl: string | null } | null;
  hackatime: { id: string | null; email: string | null } | null;
};
type ActiveMatch = {
  id: string;
  mode: Mode | "admin";
  isTest?: boolean;
  durationMinutes: number;
  theme: string;
  status: string;
  startedAt: string;
  endsAt: string;
  remainingSeconds: number;
  team: "blue" | "red";
  playerCount?: number;
};
type MatchOutcome = {
  status: string;
  winningTeam: "blue" | "red" | null;
  endReason: string | null;
  forfeitedBy: string | null;
  forfeitingTeam: "blue" | "red" | null;
  endedAt: string | null;
  remainingSeconds: number;
};
type DisconnectNotice = {
  userId: string;
  name: string;
  team: "blue" | "red";
  expiresAt: string;
  secondsRemaining: number;
};
type MediaPrefs = {
  mic: boolean;
  video: boolean;
  micDeviceId?: string;
  videoDeviceId?: string;
};
type DashboardData = {
  friends: Array<{
    id: string;
    friendshipId: string;
    name: string;
    slackId: string | null;
    avatar: AvatarConfig | null;
    lastSeenAt: string | null;
    status: string;
    incoming: boolean;
  }>;
  recent: Array<{
    id: string;
    theme: string;
    status: string;
    createdAt: string;
    opponents: Array<{ id: string; name: string; avatar: AvatarConfig | null }>;
  }>;
  challenges: Array<{
    type: string;
    progress: number;
    target: number;
    rewardElo: number;
    rewardHBucks: number;
    rewardClaimed: boolean;
  }>;
  voteGate: {
    required: number;
    cast: number;
    available: boolean;
    due: boolean;
    deferred: boolean;
  };
  globalRank: number | null;
};

const INTERACTIVE_REQUEST_TIMEOUT_MS = 12_000;

async function fetchJsonWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = INTERACTIVE_REQUEST_TIMEOUT_MS,
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const data = (await response.json().catch(() => ({}))) as T;
    return { response, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("The server took too long to respond.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function msUntilNextUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
  );
  return next - now.getTime();
}

function useCountdownToUtcMidnight() {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setRemainingMs(msUntilNextUtcMidnight());
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, []);
  if (remainingMs === null) return "--:--:--";
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(
    2,
    "0",
  );
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function isRecentlyOnline(lastSeenAt: string | null) {
  if (!lastSeenAt) return false;
  return Date.now() - new Date(lastSeenAt).getTime() < ONLINE_THRESHOLD_MS;
}

function formatLastSeen(lastSeenAt: string | null) {
  if (!lastSeenAt) return "never online";
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < ONLINE_THRESHOLD_MS) return "online now";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `online ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `online ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `online ${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `online ${weeks}w ago`;
  return `online ${new Date(lastSeenAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

// Shared dismiss behavior for modals, popovers, and inline dropdowns: Escape
// always closes whatever's open, matching whatever affordance already exists
// (a close button, a cancel action) rather than inventing a new one.
function useEscapeKey(active: boolean, onEscape: () => void) {
  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEscape();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, onEscape]);
}

// Closes on any pointerdown outside `ref`. Prefer this over a full-screen
// backdrop element for anything that can be nested inside a `transform`ed
// ancestor (e.g. the rotated paper-card treatment) — `position: fixed`
// backdrops get contained by that ancestor instead of the viewport, so
// clicks outside the card silently no-op instead of closing the popover.
function useOutsideDismiss(
  active: boolean,
  refs:
    | React.RefObject<HTMLElement | null>
    | Array<React.RefObject<HTMLElement | null>>,
  onDismiss: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const list = Array.isArray(refs) ? refs : [refs];
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      const inside = list.some(
        (ref) => ref.current && ref.current.contains(target),
      );
      if (!inside) onDismiss();
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, onDismiss]);
}

const COLORS = ["#D891D9", "#497CBF", "#D99F6C", "#BF5A5A"];

async function clearBrowserSiteData() {
  window.localStorage.clear();
  window.sessionStorage.clear();

  const cleanup: Array<Promise<unknown>> = [];
  if ("caches" in window) {
    cleanup.push(
      window.caches
        .keys()
        .then((keys) =>
          Promise.all(keys.map((key) => window.caches.delete(key))),
        ),
    );
  }
  if ("serviceWorker" in navigator) {
    cleanup.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.all(
            registrations.map((registration) => registration.unregister()),
          ),
        ),
    );
  }
  if (
    "indexedDB" in window &&
    typeof window.indexedDB.databases === "function"
  ) {
    cleanup.push(
      window.indexedDB.databases().then((databases) =>
        Promise.all(
          databases.flatMap((database) =>
            database.name
              ? [
                  new Promise<void>((resolve) => {
                    const deletion = window.indexedDB.deleteDatabase(
                      database.name!,
                    );
                    deletion.onsuccess = () => resolve();
                    deletion.onerror = () => resolve();
                    deletion.onblocked = () => resolve();
                  }),
                ]
              : [],
          ),
        ),
      ),
    );
  }

  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name)
      document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  });
  await Promise.allSettled(cleanup);
}

const starterFiles: Record<string, string> = {
  "index.html": `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body>
    <!-- to add another page, use a link: <a href="about.html">about</a>
         or a button: <button onclick="goTo('about.html')">about</button> -->
    <!-- Tailwind is enabled! e.g. class="flex items-center gap-4" -->
    <main><div class="blob"><h1>get started!</h1></div></main>
  </body>
</html>`,
  "styles.css": `body { margin: 0; font-family: ui-monospace, Menlo, monospace; background: #f8eeff; color: #20201f; }
main { min-height: 100vh; display: grid; place-items: center; }
.blob { background: #fff3b8; border: 3px solid #20201f; padding: 48px 64px;
  border-radius: 40% 60% 55% 45% / 45% 40% 60% 55%; box-shadow: 6px 6px 0 #20201f; transform: rotate(-2deg); }
h1 { font-size: 32px; margin: 0; }`,
  "script.js": `document.querySelector('.blob')?.addEventListener('click', () => {
  document.body.classList.toggle('clicked');
});`,
};

// Written before either player can see the opponent's build, so it isn't
// colored by a side-by-side comparison — this is also what lands in the
// published README and what a random one of the two teammates' copies shows
// on the voting page.
const DESCRIPTION_MAX_LENGTH = 500;

// Website previews execute player-authored JavaScript. Keep the frame's
// feature policy explicit as defense in depth on top of the opaque-origin
// sandbox: submitted sites never need access to the match camera or mic.
const PREVIEW_IFRAME_ALLOW = [
  "camera 'none'",
  "microphone 'none'",
  "geolocation 'none'",
  "display-capture 'none'",
].join("; ");
const PREVIEW_MAX_HTML_LENGTH = 1_000_000;

// GitHub Pages usually finishes its first build well within this window; it's
// just the countdown estimate shown while we poll for the real thing.
const PAGES_BUILD_ESTIMATE_SECONDS = 30;

const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(html|css|js)$/;
const FILE_TEMPLATES: Record<"html" | "css" | "js", string> = {
  html: `<!doctype html>
<html>
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
  <body>
    <!-- to travel to another page use a link: <a href="index.html">home</a>
         or a button: <button onclick="goTo('index.html')">home</button> -->
    <!-- Tailwind utility classes work out of the box, e.g. class="flex items-center gap-4" -->
  </body>
</html>`,
  css: `/* styles */\n`,
  js: `// script\n`,
};

// window.goTo(page) is the one navigation call that behaves the same in the
// live preview and on the deployed GitHub Pages site: in preview there is no
// real "about.html" to navigate to (srcDoc iframe, no server), so it asks the
// parent to swap the previewed page instead of letting a real (failing)
// navigation happen; once published there's no Ranked parent listening, so it
// falls back to a normal location.href assignment. Plain <a href="page.html">
// links are also intercepted in preview (via the click listener below) so
// players don't have to know about goTo just to link between their own pages.
function buildNavShim(fileOrder: string[], preview: boolean) {
  const htmlPages = fileOrder.filter((name) => name.endsWith(".html"));
  const normalize = `
function __rankedNormalizePage(page) {
  return String(page).split("#")[0].split("?")[0].replace(/^\\.\\//, "").replace(/^\\/+/, "");
}`;
  const clickShim = preview
    ? `
document.addEventListener("click", function (e) {
  var a = e.target && e.target.closest ? e.target.closest("a") : null;
  if (!a) return;
  var href = a.getAttribute("href");
  if (!href || /^([a-z][a-z0-9+.-]*:)?\\/\\//i.test(href) || href[0] === "#") return;
  var page = __rankedNormalizePage(href);
  if (${JSON.stringify(htmlPages)}.indexOf(page) === -1) return;
  e.preventDefault();
  window.parent.postMessage({ source: "ranked-preview", type: "navigate", page: page }, "*");
});`
    : "";
  // Re-typing srcDoc on every keystroke would make the iframe do a full
  // document navigation each time — an unload + load, which flashes the
  // browser's blank white background between the old and new page. For
  // anyone photosensitive that's a real hazard, not just a visual glitch, so
  // live content updates come in over postMessage instead and get patched
  // into the *existing* document (innerHTML swap, no navigation, no flash).
  // Scripts don't re-run from an innerHTML assignment, so each one is
  // recreated to force execution, same as the very first load.
  // Each update's HTML is the full document rebuilt from scratch, which
  // includes this very shim's own <script> tag — so recreating scripts below
  // to force re-execution would also re-run this addEventListener call,
  // stacking a second listener on top of the first. Each of those then does
  // its own recreate-and-rebind on the next message, doubling again — an
  // exponential pile-up (2, 4, 8, 16 listeners...) that grinds the page to a
  // halt within a few update cycles. window survives every innerHTML swap
  // (it's the frame's document that's being edited in place, not torn down),
  // so a flag on it makes registration idempotent across re-executions.
  const liveUpdateShim = preview
    ? `
if (!window.__rankedLiveUpdateBound) {
  window.__rankedLiveUpdateBound = true;
  window.addEventListener("message", function (e) {
    if (
      e.source !== window.parent ||
      !e.data ||
      e.data.source !== "ranked-preview" ||
      e.data.type !== "update" ||
      typeof e.data.html !== "string" ||
      e.data.html.length > ${PREVIEW_MAX_HTML_LENGTH}
    ) return;
    var next = new DOMParser().parseFromString(e.data.html, "text/html");
    document.head.innerHTML = next.head.innerHTML;
    document.body.innerHTML = next.body.innerHTML;
    var scripts = document.body.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var fresh = document.createElement("script");
      for (var j = 0; j < old.attributes.length; j++) {
        fresh.setAttribute(old.attributes[j].name, old.attributes[j].value);
      }
      fresh.textContent = old.textContent;
      old.parentNode.replaceChild(fresh, old);
    }
  });
}`
    : "";
  return `
window.__RANKED_PREVIEW__ = ${preview};${normalize}
window.goTo = function goTo(page) {
  if (window.__RANKED_PREVIEW__) {
    window.parent.postMessage({ source: "ranked-preview", type: "navigate", page: __rankedNormalizePage(page) }, "*");
  } else {
    window.location.href = page;
  }
};${clickShim}${liveUpdateShim}`;
}

// Assembles one HTML page for preview/publish by inlining every CSS file (as
// <style>) and every JS file (as <script>) alongside the requested page's markup,
// so multiple stylesheets/scripts can be split into separate files while still
// producing a single runnable document (there's no real server to resolve
// <link>/<script src> references against inside a sandboxed srcDoc iframe).
function buildPage(
  files: Record<string, string>,
  fileOrder: string[],
  htmlName: string,
  opts: { preview?: boolean } = {},
) {
  const base = files[htmlName] ?? "";
  const styles = fileOrder
    .filter((name) => name.endsWith(".css"))
    .map((name) => files[name] ?? "")
    .join("\n");
  const scripts = fileOrder
    .filter((name) => name.endsWith(".js"))
    .map((name) => files[name] ?? "")
    .join("\n");
  const navShim = buildNavShim(fileOrder, Boolean(opts.preview));
  // Splicing these in as raw text (finding "</head>"/"</body>" and inserting
  // strings around them) used to mean a player's own unclosed tag — e.g. a
  // <div missing its closing `>` — could swallow the very tags being spliced
  // in as bogus attribute soup, since the browser's HTML parser keeps
  // consuming content looking for the `>` that ends the broken start tag.
  // The player's own <script> got eaten this way too, dumping the nav shim's
  // raw JS source onto the page as visible text instead of running it.
  // Parsing through DOMParser first — the same recovery algorithm the real
  // render applies — resolves any broken markup into a real element tree
  // before anything of ours is added, so our tags are appended as actual DOM
  // nodes that can never be un-parsed back into an earlier broken tag.
  const doc = new DOMParser().parseFromString(base, "text/html");
  // Tailwind's Play CDN build needs no bundler, so it's the only way to give
  // players utility classes on a raw html/css/js page with no build step —
  // it injects its own <style> at load, ahead of styles.css in source order
  // so a player's own CSS still wins on conflicting rules. It's a no-op (a
  // few KB fetched, nothing generated) for anyone who never types a
  // Tailwind class, and this same output is what gets committed on publish,
  // so the deployed GitHub Pages site renders identically to the preview.
  const tailwindScript = doc.createElement("script");
  tailwindScript.src = "https://cdn.tailwindcss.com";
  doc.head.appendChild(tailwindScript);
  const styleEl = doc.createElement("style");
  styleEl.textContent = styles;
  doc.head.appendChild(styleEl);
  const navShimScript = doc.createElement("script");
  navShimScript.textContent = navShim;
  // Install the trusted bridge in the recovered head. Keeping it outside the
  // player-authored body means malformed body markup cannot absorb it or make
  // its source render as visible text.
  doc.head.prepend(navShimScript);
  const scriptsEl = doc.createElement("script");
  scriptsEl.textContent = scripts;
  doc.body.appendChild(scriptsEl);
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// GitHub Pages takes ~30-90s to build after the first push, so a pagesUrl
// fresh out of the publish API 404s for a bit — poll the real URL server-side
// until it resolves, with a friendly countdown so the wait doesn't read as broken.
// If the build's still not up after ~4x the usual wait, the check itself is
// probably wedged (e.g. GitHub's edge resetting our polling connection) rather
// than the build genuinely still running — surface an escape hatch instead of
// polling in silence forever.
const PAGES_STALLED_AFTER_SECONDS = PAGES_BUILD_ESTIMATE_SECONDS * 4;

function usePagesReady(url: string | undefined) {
  const [ready, setReady] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(PAGES_BUILD_ESTIMATE_SECONDS);
  const [stalled, setStalled] = useState(false);
  const [trackedUrl, setTrackedUrl] = useState(url);
  if (url !== trackedUrl) {
    setTrackedUrl(url);
    setReady(false);
    setStalled(false);
    setSecondsLeft(PAGES_BUILD_ESTIMATE_SECONDS);
  }
  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let elapsedSeconds = 0;
    const countdownTimer = setInterval(() => {
      elapsedSeconds += 1;
      setSecondsLeft((seconds) => Math.max(0, seconds - 1));
      if (elapsedSeconds >= PAGES_STALLED_AFTER_SECONDS) setStalled(true);
    }, 1000);
    (async () => {
      while (!cancelled) {
        try {
          const response = await fetch(
            `/api/github/pages-status?url=${encodeURIComponent(url)}`,
          );
          const result = (await response.json()) as { ready?: boolean };
          if (result.ready) {
            if (!cancelled) setReady(true);
            return;
          }
        } catch {
          // transient network hiccup — keep polling, don't stall the countdown
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(countdownTimer);
    };
  }, [url]);
  return { ready, secondsLeft, stalled };
}

function highlightMatch(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return text;
  // .search-match is a fixed-width, single-line row that ellipsizes overflow
  // from the end — a line-start snippet let a match anywhere past the first
  // dozen or so characters get truncated away before it was ever visible.
  // Anchoring the window a few characters before the match instead guarantees
  // the highlighted term itself is always the first thing on screen.
  const CONTEXT_BEFORE = 8;
  const start = Math.max(0, at - CONTEXT_BEFORE);
  return (
    <>
      {start > 0 ? "…" : ""}
      {text.slice(start, at)}
      <mark>{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

type IconName =
  | "external"
  | "link"
  | "plus"
  | "minus"
  | "shuffle"
  | "search"
  | "branch"
  | "settings"
  | "files"
  | "target"
  | "vote"
  | "check"
  | "person"
  | "people"
  | "mic"
  | "mic-off"
  | "camera"
  | "camera-off"
  | "flag"
  | "sticker"
  | "flipper"
  | "ipad"
  | "macbook"
  | "github"
  | "clock"
  | "star"
  | "arrow-left"
  | "lock"
  | "more";

const FILLED_ICONS = new Set<IconName>(["github", "star"]);

const ICON_PATHS: Record<IconName, React.ReactNode> = {
  external: (
    <>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </>
  ),
  link: (
    <>
      <path d="M9 15l6-6" />
      <path d="M13 5h3a4 4 0 1 1 0 8h-2" />
      <path d="M11 19H8a4 4 0 1 1 0-8h2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  shuffle: (
    <>
      <path d="M4 17h3l6-10h5" />
      <path d="M4 7h3l2.5 4" />
      <path d="m15.5 4 3 3-3 3" />
      <path d="m15.5 14 3 3-3 3" />
      <path d="M11.5 13l2.5 4h4.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="M20 20 15.3 15.3" />
    </>
  ),
  branch: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <circle cx="18" cy="12" r="2.2" />
      <path d="M6 8.2v7.6" />
      <path d="M6 8.2a6 6 0 0 0 6 6h3.8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <line x1="12" y1="4.5" x2="12" y2="7" />
      <line x1="12" y1="17" x2="12" y2="19.5" />
      <line x1="19.5" y1="12" x2="17" y2="12" />
      <line x1="7" y1="12" x2="4.5" y2="12" />
      <line x1="17.3" y1="6.7" x2="15.54" y2="8.46" />
      <line x1="8.46" y1="15.54" x2="6.7" y2="17.3" />
      <line x1="17.3" y1="17.3" x2="15.54" y2="15.54" />
      <line x1="6.7" y1="6.7" x2="8.46" y2="8.46" />
    </>
  ),
  files: (
    <>
      <path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
      <path d="M14 3v4h4" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="12" cy="12" r=".6" fill="currentColor" stroke="none" />
    </>
  ),
  vote: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M8 12.5 10.5 15 16 9" />
    </>
  ),
  check: <path d="M5 12.5 9.5 17 19 7.5" />,
  person: (
    <>
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5 20c0-3.9 3.1-6 7-6s7 2.1 7 6" />
    </>
  ),
  people: (
    <>
      <circle cx="8.5" cy="8" r="3" />
      <circle cx="16" cy="9" r="2.6" />
      <path d="M3 20c0-3.4 2.6-5.2 5.9-5.2 2 0 3.6.7 4.6 1.9" />
      <path d="M12.8 20c.3-2.7 2.3-4.2 5-4.2 2.9 0 4.7 1.7 4.7 4.2" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 19v3M9 22h6" />
    </>
  ),
  "mic-off": (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 19v3M9 22h6" />
      <path d="M3 3 21 21" />
    </>
  ),
  camera: (
    <>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 9 22 7v10l-6-2Z" />
    </>
  ),
  "camera-off": (
    <>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      <path d="M16 9 22 7v10l-6-2Z" />
      <path d="M2 2 22 22" />
    </>
  ),
  flag: (
    <>
      <path d="M5 3v18" />
      <path d="M5 4c2-1.4 4-1.4 6 0s4 1.4 6 0v8c-2 1.4-4 1.4-6 0s-4-1.4-6 0Z" />
    </>
  ),
  sticker: (
    <>
      <path d="M6 4h9l5 5v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z" />
      <path d="M15 4v5h5" />
      <path d="M8 15c1.4 1 2.9 1.3 4.4 0" />
    </>
  ),
  flipper: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <rect x="8.5" y="6" width="7" height="6" rx="1" />
      <circle cx="9.5" cy="16" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="16" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="16" r="1" fill="currentColor" stroke="none" />
      <path d="M9 19h6" />
    </>
  ),
  ipad: (
    <>
      <rect x="6" y="2.5" width="12" height="19" rx="2" />
      <circle cx="12" cy="18.6" r=".8" fill="currentColor" stroke="none" />
    </>
  ),
  macbook: (
    <>
      <rect x="4" y="5" width="16" height="10" rx="1.2" />
      <path d="M2 18h20l-1.6 2.2a2 2 0 0 1-1.6.8H5.2a2 2 0 0 1-1.6-.8L2 18Z" />
    </>
  ),
  github: (
    <path d="M8 0c4.42 0 8 3.58 8 8a8 8 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.66-.21-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.54-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A8.013 8.013 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  star: <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4Z" />,
  "arrow-left": (
    <>
      <path d="M19 12H5" />
      <path d="M11 6 5 12l6 6" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </>
  ),
  more: (
    <>
      <circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none" />
      <circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none" />
    </>
  ),
};

function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  const filled = FILLED_ICONS.has(name);
  return (
    <svg
      aria-hidden="true"
      className={className ? `icon ${className}` : "icon"}
      width={size}
      height={size}
      viewBox={name === "github" ? "0 0 16 16" : "0 0 24 24"}
      fill={filled ? "currentColor" : "none"}
      stroke={filled ? "none" : "currentColor"}
      strokeWidth={filled ? 0 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <button
      className={`logo ${compact ? "compact" : ""}`}
      onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
      aria-label="Ranked home"
    >
      <span>HACK CLUB</span>
      <em>ranked</em>
    </button>
  );
}

function ProgressBar({ elo = 1500 }: { elo?: number }) {
  const progress = Math.max(0, Math.min(100, ((elo - 1500) / 1500) * 100));
  return (
    <div className="rank-wrap" aria-label={`Elo rating ${elo}`}>
      <div className="rank-labels">
        <span className="rank-tier current">meteor</span>
        <strong>
          {elo} <small>elo</small>
        </strong>
        <span className="rank-tier target">celestial</span>
      </div>
      <div className="rank-track">
        <div className="rank-fill" style={{ width: `${progress}%` }} />
        <i className="rank-dot" style={{ left: `${progress}%` }} />
      </div>
      <div className="rank-meta">{Math.max(0, 3000 - elo)} to celestial</div>
    </div>
  );
}

function SiteHeader({
  screen,
  navigate,
  onProfile,
  balance,
  avatar,
  showAdmin = false,
  wardrobeUnlocked,
  toast,
}: {
  screen: Screen;
  navigate: (s: Screen) => void;
  onProfile: () => void;
  balance: number;
  avatar?: AvatarConfig;
  showAdmin?: boolean;
  wardrobeUnlocked: boolean;
  toast: (m: string) => void;
}) {
  return (
    <header className="site-header">
      <nav aria-label="Main navigation">
        <button
          className={screen === "shop" ? "active" : ""}
          onClick={() => navigate("shop")}
        >
          shop <span className="nav-pill">{balance} Ħ</span>
        </button>
        <button
          className={screen === "leaderboard" ? "active" : ""}
          onClick={() => navigate("leaderboard")}
        >
          leaderboard
        </button>
        <button
          className={screen === "wardrobe" ? "active" : ""}
          onClick={() =>
            wardrobeUnlocked
              ? navigate("wardrobe")
              : toast(
                  "Buy your first avatar item in the Shop to unlock the Wardrobe",
                )
          }
        >
          wardrobe
          {!wardrobeUnlocked && (
            <span className="nav-pill nav-pill-locked">
              <Icon name="lock" size={9} />
            </span>
          )}
        </button>
        {showAdmin && (
          <button
            className={screen === "admin" ? "active" : ""}
            onClick={() => navigate("admin")}
          >
            admin
          </button>
        )}
      </nav>
      <Logo />
      <button
        className="profile-button"
        onClick={onProfile}
        aria-label="Open profile and account settings"
      >
        <ScribbleAvatar size="sm" avatar={avatar} />
        <span className="online-dot" />
      </button>
    </header>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="card-title">
      <span>{children}</span>
    </h2>
  );
}

function PersonFace({
  name,
  avatar,
}: {
  name: string;
  avatar?: AvatarConfig | null;
}) {
  return (
    <span className="mini-face mini-face-avatar">
      <ScribbleAvatar size="sm" avatar={avatar} label={`${name}'s avatar`} />
    </span>
  );
}

type PublicPlayerProfile = {
  id: string;
  name: string;
  avatar: AvatarConfig | null;
  elo: number;
  hours: number;
  matchesPlayed: number;
  githubRepoUrl: string | null;
  githubGalleryUrl: string | null;
};

const HOVER_CARD_WIDTH = 264;
// Rough ceiling on the card's rendered height (identity row + stat row +
// link row + padding), used only to decide which side of the trigger has
// room — not for pixel-perfect placement, so an estimate is fine; the
// useLayoutEffect clamp below corrects against the card's *real* height
// once it's rendered. Kept deliberately generous rather than tuned to the
// exact current layout, since a condensed card that's shorter than this
// estimate is safe (it'll just have a bit more clearance than strictly
// needed) while an estimate that's too small is what actually risks
// clipping — see the friends-card-avatar regression this constant exists
// to prevent, from when the card briefly had a much taller hero banner.
const HOVER_CARD_EST_HEIGHT = 260;

type HoverCardAnchor = { left: number; top?: number; bottom?: number };

// Anchored just above the trigger by default, clamped to stay on-screen
// horizontally. Flips below the trigger instead when there isn't
// reasonably enough room above for the card *and* below actually has
// more room — `bottom`/`top` (rather than a placement computed from the
// card's own measured height) anchors it without needing to measure the
// card first, so it never flashes in the wrong spot for a frame before
// correcting itself.
function hoverCardPosition(rect: DOMRect) {
  const gap = 10;
  const edgeMargin = 12;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - HOVER_CARD_WIDTH / 2, edgeMargin),
    window.innerWidth - HOVER_CARD_WIDTH - edgeMargin,
  );
  const spaceAbove = rect.top;
  const spaceBelow = window.innerHeight - rect.bottom;
  const openBelow =
    spaceAbove < HOVER_CARD_EST_HEIGHT + gap && spaceBelow > spaceAbove;
  return openBelow
    ? { left, top: rect.bottom + gap }
    : { left, bottom: window.innerHeight - rect.top + gap };
}

// Shared by every screen that shows other players' profile pictures
// (friends, recent interactions, the leaderboard): hovering (or focusing,
// for keyboard/touch users who can't hover) a trigger opens the card
// anchored to it. A short close delay lets the cursor travel from the
// trigger onto the card itself — e.g. to click its gallery/repo links —
// without it vanishing first; entering the card cancels that delay.
function useProfileHoverCard() {
  const [openProfileId, setOpenProfileId] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<HoverCardAnchor | null>(null);
  const closeTimer = useRef<number | undefined>(undefined);

  const cancelClose = useCallback(() => {
    window.clearTimeout(closeTimer.current);
  }, []);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpenProfileId(null), 150);
  }, [cancelClose]);
  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const triggerProps = (userId: string) => ({
    onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
      cancelClose();
      setOpenProfileId(userId);
      setAnchor(hoverCardPosition(event.currentTarget.getBoundingClientRect()));
    },
    onMouseLeave: scheduleClose,
    onFocus: (event: React.FocusEvent<HTMLElement>) => {
      cancelClose();
      setOpenProfileId(userId);
      setAnchor(hoverCardPosition(event.currentTarget.getBoundingClientRect()));
    },
    onBlur: scheduleClose,
  });

  return { openProfileId, anchor, triggerProps, cancelClose, scheduleClose };
}

// Anyone's profile picture — leaderboard rows, friends, recent opponents —
// opens this same read-only hover card. Deliberately not the account
// ProfileModal (that one edits *your own* avatar/connections and has a
// logout button); this is a public glance at someone else's stats.
function PlayerProfileCard({
  userId,
  anchor,
  onMouseEnter,
  onMouseLeave,
}: {
  userId: string;
  anchor: HoverCardAnchor;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const [profile, setProfile] = useState<PublicPlayerProfile | null>(null);
  const [failed, setFailed] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  // Unique per mount so multiple cards (unlikely today, but not impossible
  // across a hot reload) never collide on the same gradient id.
  const ringGradientId = useId();

  // hoverCardPosition's above/below choice only has an *estimate* of the
  // card's height to work with (it has to decide before anything has
  // rendered). Once the real content is in and the card has its actual
  // height, re-check against the viewport and clamp — this is what catches
  // the case the estimate got wrong (e.g. a long name wrapping to two
  // lines) instead of letting the card run off the top or bottom of the
  // screen. useLayoutEffect (not useEffect) so the correction lands before
  // the browser paints, not as a visible jump after.
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const margin = 12;
    const rect = el.getBoundingClientRect();
    if (rect.top < margin) {
      el.style.top = `${margin}px`;
      el.style.bottom = "auto";
    } else if (rect.bottom > window.innerHeight - margin) {
      el.style.top = `${Math.max(margin, window.innerHeight - margin - rect.height)}px`;
      el.style.bottom = "auto";
    }
  }, [profile, failed, anchor]);

  useEffect(() => {
    // A fresh PlayerProfileCard mounts each time a new userId opens (the
    // caller only ever renders it behind `openProfileId &&`), so there's no
    // stale profile/failed state from a previous hover to clear here — the
    // useState initial values already are that reset.
    let cancelled = false;
    fetch(`/api/users/${userId}/profile`)
      .then((response) => (response.ok ? response.json() : Promise.reject()))
      .then((data: PublicPlayerProfile) => {
        if (!cancelled) setProfile(data);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Mirrors the exact floor/ceiling and copy the home screen's own
  // ProgressBar already uses (1500 "meteor" -> 3000 "celestial") — Ranked
  // only has this one band today, not a multi-tier ladder, so the ring
  // shows progress toward that same single target rather than inventing a
  // tier system that doesn't exist elsewhere in the product.
  const eloProgressRaw = profile
    ? Math.max(0, Math.min(100, ((profile.elo - 1500) / 1500) * 100))
    : 0;
  // Anyone below 1500 (a brand new account, or anyone who's lost more than
  // won) legitimately computes to 0% — which, rendered as an actual 0-length
  // arc, is indistinguishable from no fill at all: exactly the "this just
  // looks like a plain circle" report. A small floor keeps a sliver of the
  // fill color always visible so the ring reads as a live progress meter
  // even at the bottom of the range, not as decoration that happens to be
  // empty right now.
  const eloProgress = Math.max(eloProgressRaw, 7);
  const eloRemaining = profile ? Math.max(0, 3000 - profile.elo) : 0;
  const ringRadius = 24;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const ringOffset = ringCircumference * (1 - eloProgress / 100);

  return createPortal(
    <section
      ref={cardRef}
      className="player-card-modal"
      role="dialog"
      aria-labelledby="player-card-title"
      style={{
        left: anchor.left,
        top: anchor.top,
        bottom: anchor.bottom,
        width: HOVER_CARD_WIDTH,
      }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {failed ? (
        <p className="player-card-status">Couldn&apos;t load that profile.</p>
      ) : !profile ? (
        <p className="player-card-status">loading…</p>
      ) : (
        <>
          <div className="player-card-identity">
            <ScribbleAvatar avatar={profile.avatar} size="sm" />
            <div className="player-card-identity-text">
              <h2 id="player-card-title">{profile.name}</h2>
            </div>
            <div
              className="player-card-ring"
              aria-hidden="true"
              title={
                eloRemaining > 0
                  ? `${eloRemaining} to celestial`
                  : "celestial rank"
              }
            >
              <svg viewBox="0 0 60 60" width="60" height="60">
                <defs>
                  {/* Same two stops as the home screen's own ELO bar
                      (.rank-fill: linear-gradient(90deg, #aec158, var(--green)))
                      — this ring and that bar are the same signal in two
                      shapes, so they're built from the same gradient. */}
                  <linearGradient
                    id={ringGradientId}
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0%" stopColor="#aec158" />
                    <stop offset="100%" stopColor="var(--green)" />
                  </linearGradient>
                </defs>
                <circle
                  className="player-card-ring-track"
                  cx="30"
                  cy="30"
                  r={ringRadius}
                />
                <circle
                  className="player-card-ring-fill"
                  cx="30"
                  cy="30"
                  r={ringRadius}
                  stroke={`url(#${ringGradientId})`}
                  style={{
                    strokeDasharray: ringCircumference,
                    strokeDashoffset: ringOffset,
                  }}
                />
              </svg>
              <div className="player-card-ring-label">
                <strong>{profile.elo}</strong>
                <span>elo</span>
              </div>
            </div>
          </div>
          <div className="player-card-stats">
            <div>
              <strong>{profile.hours}</strong>
              <span>hours coded</span>
            </div>
            <div>
              <strong>{profile.matchesPlayed}</strong>
              <span>{profile.matchesPlayed === 1 ? "match" : "matches"}</span>
            </div>
          </div>
          {profile.githubGalleryUrl || profile.githubRepoUrl ? (
            <div className="player-card-links">
              {profile.githubGalleryUrl && (
                <a
                  href={profile.githubGalleryUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="external" size={13} /> gallery
                </a>
              )}
              {profile.githubRepoUrl && (
                <a
                  href={profile.githubRepoUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="github" size={13} /> repo
                </a>
              )}
            </div>
          ) : (
            <p className="player-card-status">
              hasn&apos;t published a build yet
            </p>
          )}
        </>
      )}
    </section>,
    document.body,
  );
}

function Home({
  navigate,
  toast,
  auth,
  startOnboarding,
  customizeAvatar,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  startOnboarding: () => void;
  customizeAvatar: () => void;
}) {
  const profileCard = useProfileHoverCard();
  const [friendRequests, setFriendRequests] = useState<string[]>([]);
  const [friendDirectory, setFriendDirectory] = useState<
    Array<{ id: string; name: string; email: string }>
  >([]);
  const [slackQuery, setSlackQuery] = useState("");
  const [selectedFriend, setSelectedFriend] = useState<{
    id: string;
    name: string;
    email: string;
  } | null>(null);
  const [slackSuggestionsOpen, setSlackSuggestionsOpen] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [voteGateOpen, setVoteGateOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [friendMenuOpen, setFriendMenuOpen] = useState<string | null>(null);
  const [friendMenuConfirm, setFriendMenuConfirm] = useState<
    "block" | "unfriend" | null
  >(null);
  const [blockedFriends, setBlockedFriends] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [blockedMenuOpen, setBlockedMenuOpen] = useState(false);
  const blockedMenuAnchorRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(blockedMenuOpen, blockedMenuAnchorRef, () =>
    setBlockedMenuOpen(false),
  );
  useEscapeKey(blockedMenuOpen, () => setBlockedMenuOpen(false));
  const slackQueryInputRef = useRef<HTMLInputElement>(null);
  const slackMatches = useMemo(() => {
    const q = slackQuery.replace(/^@/, "").trim().toLowerCase();
    if (!q || selectedFriend) return [];
    return friendDirectory
      .filter(
        (member) =>
          member.name.toLowerCase().includes(q) ||
          member.email.toLowerCase().includes(q),
      )
      .slice(0, 6);
  }, [friendDirectory, slackQuery, selectedFriend]);
  const resetsIn = useCountdownToUtcMidnight();
  const recentInteractions =
    dashboard?.recent
      .flatMap(
        (match) =>
          match.opponents?.map((opponent) => ({
            ...opponent,
            theme: match.theme,
            matchId: match.id,
          })) ?? [],
      )
      .slice(0, 3) ?? [];

  useEffect(() => {
    if (!auth.user) return;
    fetch("/api/dashboard")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setDashboard(data))
      .catch(() => undefined);
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) return;
    fetch("/api/friends")
      .then((response) => (response.ok ? response.json() : null))
      .then(
        (data) =>
          data &&
          setBlockedFriends(
            (data.friends ?? [])
              .filter(
                (friend: { status: string }) => friend.status === "blocked",
              )
              .map((friend: { id: string; name: string }) => ({
                id: friend.id,
                name: friend.name,
              })),
          ),
      )
      .catch(() => undefined);
  }, [auth.user]);

  useEffect(() => {
    if (!auth.user) return;
    fetch("/api/friends/directory")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setFriendDirectory(data.members ?? []))
      .catch(() => undefined);
  }, [auth.user]);

  const addFriend = async (id: string, name: string) => {
    if (friendRequests.includes(id))
      return toast(`You already nudged @${name}`);
    try {
      const response = await fetch("/api/friends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: id }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok)
        return toast(result?.error ?? "Could not send that request");
      setFriendRequests((current) => [...current, id]);
      toast(`Friend request sent to @${name}`);
    } catch {
      toast("Could not send that request — check your connection");
    }
  };

  const addSlackFriend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedFriend) {
      try {
        const response = await fetch("/api/friends", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ targetUserId: selectedFriend.id }),
        });
        const result = await response.json().catch(() => null);
        if (!response.ok)
          return toast(result?.error ?? "Could not send that friend request");
        setSlackQuery("");
        setSelectedFriend(null);
        return toast("Friend request sent");
      } catch {
        return toast(
          "Could not send that friend request, check your connection",
        );
      }
    }
    const handle = slackQuery.replace(/^@/, "").trim();
    if (!handle) return;
    const message = `${auth.user?.name ?? "Someone"} has invited you to match-up on Hack Club Ranked! Join the match: <https://ranked.hackclub.com?utm_source=game_invite|ranked.hackclub.com>`;
    void navigator.clipboard.writeText(message);
    setSlackQuery("");
    toast(`@${handle} hasn't joined Ranked yet. Copied invite to clipboard!`);
  };

  const acceptFriend = async (friendshipId: string) => {
    const response = await fetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendshipId, action: "accept" }),
    });
    if (!response.ok) return toast("Could not accept that request");
    setDashboard((current) =>
      current
        ? {
            ...current,
            friends: current.friends.map((friend) =>
              friend.friendshipId === friendshipId
                ? { ...friend, status: "accepted" }
                : friend,
            ),
          }
        : current,
    );
    toast("Friend added");
  };

  const removeFriendFromDashboard = (friendshipId: string) =>
    setDashboard((current) =>
      current
        ? {
            ...current,
            friends: current.friends.filter(
              (friend) => friend.friendshipId !== friendshipId,
            ),
          }
        : current,
    );

  const closeFriendMenu = () => {
    setFriendMenuOpen(null);
    setFriendMenuConfirm(null);
  };
  const friendMenuAnchorRef = useRef<HTMLDivElement>(null);
  const friendMenuPopoverRef = useRef<HTMLDivElement>(null);
  const [friendMenuPosition, setFriendMenuPosition] = useState<{
    top: number;
    right: number;
  } | null>(null);
  useOutsideDismiss(
    Boolean(friendMenuOpen),
    [friendMenuAnchorRef, friendMenuPopoverRef],
    closeFriendMenu,
  );
  useEscapeKey(Boolean(friendMenuOpen), closeFriendMenu);
  // The friends list scrolls internally (overflow-y: auto) and the whole card
  // is rotated via `transform`, which makes `position: fixed` descendants of
  // it track the card instead of the viewport — so the menu is portaled to
  // <body> and positioned from the button's own rect instead of being an
  // absolutely-positioned child of the (clipping) scroll container. Since the
  // portaled menu no longer scrolls with the list, close it on scroll/resize
  // rather than let it drift away from the button it belongs to.
  useEffect(() => {
    if (!friendMenuOpen) return;
    const close = () => closeFriendMenu();
    document.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [friendMenuOpen]);
  useEscapeKey(voteGateOpen, () => setVoteGateOpen(false));
  useEscapeKey(slackSuggestionsOpen, () => setSlackSuggestionsOpen(false));

  const blockFriend = async (friendshipId: string, name: string) => {
    closeFriendMenu();
    const response = await fetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendshipId, action: "block" }),
    });
    if (!response.ok) return toast("Could not block that friend");
    removeFriendFromDashboard(friendshipId);
    setBlockedFriends((current) => [{ id: friendshipId, name }, ...current]);
    toast(`Blocked @${name}`);
  };

  const unfriendFriend = async (friendshipId: string, name: string) => {
    closeFriendMenu();
    const response = await fetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendshipId, action: "unfriend" }),
    });
    if (!response.ok) return toast("Could not remove that friend");
    removeFriendFromDashboard(friendshipId);
    toast(`Removed @${name} from friends`);
  };

  const unblockFriend = async (friendshipId: string, name: string) => {
    const response = await fetch("/api/friends", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendshipId, action: "unblock" }),
    });
    if (!response.ok) return toast("Could not unblock that person");
    setBlockedFriends((current) =>
      current.filter((friend) => friend.id !== friendshipId),
    );
    toast(`Unblocked @${name}`);
  };

  return (
    <main className="home-screen screen-pad">
      <ProgressBar elo={auth.user?.elo} />
      <section className="home-grid">
        <aside className="home-left">
          <div className="paper-card friends-card">
            <CardTitle>
              friends{" "}
              <button
                aria-label="Add a friend"
                onClick={() => slackQueryInputRef.current?.focus()}
              >
                <Icon name="plus" size={13} />
              </button>
              {blockedFriends.length > 0 && (
                <span
                  className="blocked-menu-anchor"
                  ref={blockedMenuAnchorRef}
                >
                  <button
                    aria-label="Manage blocked people"
                    aria-expanded={blockedMenuOpen}
                    onClick={() => setBlockedMenuOpen((open) => !open)}
                  >
                    <Icon name="lock" size={12} />
                  </button>
                  {blockedMenuOpen && (
                    <div className="blocked-menu" role="menu">
                      <strong>blocked</strong>
                      <ul>
                        {blockedFriends.map((friend) => (
                          <li key={friend.id}>
                            <span title={friend.name}>{friend.name}</span>
                            <button
                              role="menuitem"
                              onClick={() =>
                                void unblockFriend(friend.id, friend.name)
                              }
                            >
                              unblock
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </span>
              )}
            </CardTitle>
            <ul className="people-list">
              {dashboard?.friends.length ? (
                dashboard.friends.map((friend) => {
                  const online = isRecentlyOnline(friend.lastSeenAt);
                  const menuOpen = friendMenuOpen === friend.friendshipId;
                  return (
                    <li key={friend.id}>
                      <button
                        type="button"
                        className="person-face-button"
                        {...profileCard.triggerProps(friend.id)}
                        aria-label={`View ${friend.name}'s profile`}
                      >
                        <PersonFace name={friend.name} avatar={friend.avatar} />
                      </button>
                      <div>
                        <strong>{friend.name}</strong>
                        <small className="last-seen">
                          {friend.status === "accepted" ? (
                            <>
                              {formatLastSeen(friend.lastSeenAt)}
                              <i
                                className={`status${online ? "" : " offline"}`}
                              />
                            </>
                          ) : friend.incoming ? (
                            "request received"
                          ) : (
                            "request sent"
                          )}
                        </small>
                      </div>
                      {friend.status === "pending" && friend.incoming ? (
                        <button
                          onClick={() => void acceptFriend(friend.friendshipId)}
                        >
                          accept
                        </button>
                      ) : friend.status === "accepted" ? (
                        <div
                          className="friend-menu-anchor"
                          ref={menuOpen ? friendMenuAnchorRef : undefined}
                        >
                          <button
                            className="friend-menu-button"
                            onClick={(event) => {
                              if (menuOpen) return closeFriendMenu();
                              const rect =
                                event.currentTarget.getBoundingClientRect();
                              setFriendMenuPosition({
                                top: rect.bottom + 8,
                                right: window.innerWidth - rect.right,
                              });
                              setFriendMenuOpen(friend.friendshipId);
                              setFriendMenuConfirm(null);
                            }}
                            aria-label={`Manage ${friend.name}`}
                            aria-expanded={menuOpen}
                          >
                            <Icon name="settings" size={13} />
                          </button>
                          {menuOpen &&
                            friendMenuPosition &&
                            createPortal(
                              <div
                                className="friend-menu"
                                role="menu"
                                ref={friendMenuPopoverRef}
                                style={{
                                  top: friendMenuPosition.top,
                                  right: friendMenuPosition.right,
                                }}
                              >
                                <button
                                  role="menuitem"
                                  className={
                                    friendMenuConfirm === "unfriend"
                                      ? "confirming"
                                      : ""
                                  }
                                  onClick={() =>
                                    friendMenuConfirm === "unfriend"
                                      ? void unfriendFriend(
                                          friend.friendshipId,
                                          friend.name,
                                        )
                                      : setFriendMenuConfirm("unfriend")
                                  }
                                >
                                  <Icon name="minus" size={13} />
                                  {friendMenuConfirm === "unfriend"
                                    ? "click again to remove"
                                    : "unfriend"}
                                </button>
                                <button
                                  role="menuitem"
                                  className={
                                    friendMenuConfirm === "block"
                                      ? "confirming"
                                      : "danger"
                                  }
                                  onClick={() =>
                                    friendMenuConfirm === "block"
                                      ? void blockFriend(
                                          friend.friendshipId,
                                          friend.name,
                                        )
                                      : setFriendMenuConfirm("block")
                                  }
                                >
                                  <Icon name="flag" size={13} />
                                  {friendMenuConfirm === "block"
                                    ? "click again to block"
                                    : "block"}
                                </button>
                              </div>,
                              document.body,
                            )}
                        </div>
                      ) : (
                        <i className="status offline" />
                      )}
                    </li>
                  );
                })
              ) : (
                <li>
                  <div>
                    <strong>No teammates yet</strong>
                    <small>Add someone from a recent match.</small>
                  </div>
                </li>
              )}
            </ul>
            <form
              className="friend-search"
              onSubmit={(event) => void addSlackFriend(event)}
            >
              <div className="slack-picker">
                <input
                  ref={slackQueryInputRef}
                  value={slackQuery}
                  onChange={(event) => {
                    setSlackQuery(event.target.value);
                    setSelectedFriend(null);
                    setSlackSuggestionsOpen(true);
                  }}
                  onFocus={() => setSlackSuggestionsOpen(true)}
                  onBlur={() => setSlackSuggestionsOpen(false)}
                  placeholder="ex. Fiona Hacksworth"
                  autoComplete="off"
                  required
                />
                {slackSuggestionsOpen && slackMatches.length > 0 && (
                  <ul className="slack-suggestions">
                    {slackMatches.map((member) => (
                      <li key={member.id}>
                        <button
                          type="button"
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSelectedFriend(member);
                            setSlackQuery(member.name);
                            setSlackSuggestionsOpen(false);
                          }}
                        >
                          <strong>{member.name}</strong>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <button type="submit" disabled={!slackQuery.trim()}>
                add
              </button>
            </form>
          </div>
          <div className="paper-card interactions-card">
            <CardTitle>recent interactions</CardTitle>
            <ul className="interaction-list">
              {recentInteractions.length ? (
                recentInteractions.map((interaction) => (
                  <li key={`${interaction.matchId}-${interaction.id}`}>
                    <button
                      type="button"
                      className="person-face-button"
                      {...profileCard.triggerProps(interaction.id)}
                      aria-label={`View ${interaction.name}'s profile`}
                    >
                      <PersonFace
                        name={interaction.name}
                        avatar={interaction.avatar}
                      />
                    </button>
                    <div>
                      <strong>{interaction.name}</strong>
                      <small>{interaction.theme}</small>
                    </div>
                    <button
                      className={
                        friendRequests.includes(interaction.id) ? "sent" : ""
                      }
                      onClick={() =>
                        void addFriend(interaction.id, interaction.name)
                      }
                      aria-label={`Add ${interaction.name} as a friend`}
                    >
                      {friendRequests.includes(interaction.id) ? (
                        <Icon name="check" size={12} />
                      ) : (
                        <Icon name="plus" size={12} />
                      )}
                    </button>
                  </li>
                ))
              ) : (
                <li>
                  <div>
                    <strong>No interactions yet</strong>
                    <small>
                      Opponents and teammates will show up here after your first
                      match.
                    </small>
                  </div>
                </li>
              )}
            </ul>
          </div>
        </aside>

        <section className="hero-zone">
          {dashboard?.globalRank && (
            <div className="elo-sticker">
              #{dashboard.globalRank} <span>global</span>
            </div>
          )}
          <button
            type="button"
            className="hero-avatar-button"
            onClick={customizeAvatar}
            aria-label={
              auth.user ? "Customize your Scrib" : "Create your Scrib"
            }
          >
            <ScribbleAvatar
              avatar={auth.user?.avatar}
              label="Your scribble avatar"
            />
            <span>
              {auth.user ? "customize" : "make your scrib"} <i>↗</i>
            </span>
          </button>
          <div className="hero-copy">
            <button
              className="primary-button start-button"
              disabled={starting}
              onClick={async () => {
                if (!auth.user) return startOnboarding();
                setStarting(true);
                try {
                  const fresh = await fetch("/api/dashboard")
                    .then((r) => (r.ok ? r.json() : null))
                    .catch(() => null);
                  if (!fresh)
                    return toast("Could not reach the server, try again.");
                  setDashboard(fresh);
                  if (fresh.voteGate.due) return setVoteGateOpen(true);
                  navigate("lobby");
                } finally {
                  setStarting(false);
                }
              }}
            >
              {starting ? (
                <>
                  <i className="spinner" /> starting…
                </>
              ) : (
                <>
                  {auth.user ? "start match" : "sign in to play"}{" "}
                  <Icon name="external" size={18} />
                </>
              )}
            </button>
            <div className="queue-note">
              <i />{" "}
              {auth.user
                ? `${auth.user.name} · authenticated`
                : "Hack Club account required"}
            </div>
          </div>
        </section>

        <aside className="home-right">
          <DailyChallenges
            challenges={dashboard?.challenges ?? []}
            resetsIn={resetsIn}
          />
          <div className="paper-card vote-nudge">
            <div className="vote-icon">
              <Icon name="vote" size={16} />
            </div>
            <div>
              <strong>
                {dashboard?.voteGate.due
                  ? `${dashboard.voteGate.required - dashboard.voteGate.cast} vote due`
                  : dashboard?.voteGate.available
                    ? "community voting"
                    : "no votes waiting"}
              </strong>
              <span>
                {dashboard?.voteGate.due
                  ? "Vote to unlock your next match"
                  : dashboard?.voteGate.available
                    ? "Help choose another match winner"
                    : dashboard?.voteGate.deferred
                      ? "You can keep playing until a vote appears"
                      : "Fresh matchups will appear here"}
              </span>
            </div>
            {dashboard?.voteGate.available && (
              <button onClick={() => navigate("vote")}>vote now</button>
            )}
          </div>
        </aside>
      </section>
      {voteGateOpen && (
        <div className="modal-backdrop" onClick={() => setVoteGateOpen(false)}>
          <section
            className="modal vote-gate-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="close-button"
              onClick={() => setVoteGateOpen(false)}
              aria-label="Close"
            >
              ×
            </button>
            <h2>
              Vote on{" "}
              {Math.max(
                0,
                (dashboard?.voteGate.required ?? 0) -
                  (dashboard?.voteGate.cast ?? 0),
              )}{" "}
              other match
              {Math.max(
                0,
                (dashboard?.voteGate.required ?? 0) -
                  (dashboard?.voteGate.cast ?? 0),
              ) === 1
                ? ""
                : "es"}{" "}
              to start a new match.
            </h2>
            <p>
              Every 3 matches you play, Ranked asks you to help judge 5 other
              finished builds before you can queue again.
            </p>
            <button
              className="primary-button"
              onClick={() => {
                setVoteGateOpen(false);
                navigate("vote");
              }}
            >
              vote now <Icon name="external" size={16} />
            </button>
          </section>
        </div>
      )}
      {profileCard.openProfileId && profileCard.anchor && (
        <PlayerProfileCard
          userId={profileCard.openProfileId}
          anchor={profileCard.anchor}
          onMouseEnter={profileCard.cancelClose}
          onMouseLeave={profileCard.scheduleClose}
        />
      )}
    </main>
  );
}

function Challenge({
  label,
  value,
  progress,
  reward,
}: {
  label: string;
  value: string;
  progress: number;
  reward: string;
}) {
  return (
    <div className="challenge">
      <div>
        <strong>{label}</strong>
        <span>{value}</span>
      </div>
      <div className="challenge-track">
        <i style={{ width: `${progress}%` }} />
      </div>
      <small>{reward}</small>
    </div>
  );
}

const CHALLENGE_LABELS: Record<string, string> = {
  play_matches: "Play 2 matches",
  code_seconds: "Code for 3 hours",
  add_friends: "Make 2 friends",
  win_matches: "Win a match",
  cast_votes: "Vote on 3 community builds",
  publish_project: "Publish your project",
  duo_match: "Play a duo match",
  duo_invite_sent: "Invite a friend to a duo match",
  shop_purchase: "Buy something from the shop",
  send_friend_request: "Send 2 friend requests",
};

function DailyChallenges({
  challenges,
  resetsIn,
}: {
  challenges: DashboardData["challenges"];
  resetsIn: string;
}) {
  return (
    <div className="paper-card daily-card">
      <CardTitle>daily challenges</CardTitle>

      <div className="challenge-list">
        {challenges.map((challenge) => (
          <Challenge
            key={challenge.type}
            label={CHALLENGE_LABELS[challenge.type] ?? challenge.type}
            value={`${Math.min(challenge.progress, challenge.target)} / ${challenge.target}`}
            progress={Math.min(
              100,
              (challenge.progress / challenge.target) * 100,
            )}
            reward={
              challenge.rewardElo
                ? `+${challenge.rewardElo} ELO`
                : `+${challenge.rewardHBucks} Ħ`
            }
          />
        ))}
      </div>
      <small className="resets">resets in {resetsIn}</small>
    </div>
  );
}

type OnboardingStep =
  | "avatar"
  | "hackclub"
  | "github"
  | "hackatime"
  | "placement";
type AvatarDraft = ResolvedAvatarConfig;
const PENDING_AVATAR_KEY = "ranked_pending_avatar";

function OnboardingModal({
  step,
  avatar,
  setAvatar,
  onAvatarContinue,
  onConnectHackClub,
  onBackToAvatar,
  onSelectExperience,
  close,
}: {
  step: OnboardingStep;
  avatar?: AvatarDraft;
  setAvatar?: (next: AvatarDraft) => void;
  onAvatarContinue?: () => void;
  onConnectHackClub?: () => void;
  onBackToAvatar?: () => void;
  onSelectExperience?: (e: Experience) => void;
  close: () => void;
}) {
  const levels: {
    key: Experience;
    title: string;
    desc: string;
    stars: number;
  }[] = [
    {
      key: "beginner",
      title: "Beginner",
      desc: "Not many websites made, yet.",
      stars: 1,
    },
    {
      key: "intermediate",
      title: "Intermediate",
      desc: "I know my HTML & CSS basics.",
      stars: 2,
    },
    {
      key: "expert",
      title: "Expert",
      desc: "HTML / CSS / JS is my playground.",
      stars: 3,
    },
  ];
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="onboarding-title"
    >
      <section className="modal onboarding-modal">
        <button className="close-button" onClick={close} aria-label="Close">
          ×
        </button>

        {step === "avatar" && avatar && setAvatar && (
          <>
            <h2 id="onboarding-title">Draw your scribble.</h2>
            <p>
              This is you on the ladder, in calls, and on the leaderboard. Make
              it weird—you can remix it later from your profile.
            </p>
            <AvatarCustomizer value={avatar} onChange={setAvatar} />
            <button
              className="primary-button continue-button"
              onClick={onAvatarContinue}
            >
              continue <Icon name="external" size={16} />
            </button>
          </>
        )}

        {step === "hackclub" && avatar && (
          <div className="connect-step hackclub">
            <div className="connect-badge">
              <Icon name="flag" size={30} />
            </div>
            <h2 id="onboarding-title">Connect Hack Club.</h2>
            <p>
              Ranked runs on Hack Club identity. Connecting links your ELO,
              matches, and H-Bucks to your actual Hack Club account, no separate
              password to lose.
            </p>
            <div className="avatar-preview-note">
              <ScribbleAvatar
                size="sm"
                avatar={avatar}
                label="Your chosen avatar"
              />
              <span>this scribble is coming with you</span>
            </div>
            <button className="primary-button" onClick={onConnectHackClub}>
              connect Hack Club auth <Icon name="external" size={16} />
            </button>
            <button className="onboarding-back" onClick={onBackToAvatar}>
              ← back to avatar
            </button>
          </div>
        )}

        {step === "github" && (
          <div className="connect-step github">
            <div className="connect-badge">
              <Icon name="github" size={30} />
            </div>
            <h2 id="onboarding-title">Connect GitHub</h2>
            <p>
              Every finished match gets published as a folder inside one
              monorepo on your account and deployed with GitHub Pages.
            </p>
            <a className="primary-button" href="/api/auth/github/start">
              <Icon name="github" size={16} /> connect GitHub
            </a>
          </div>
        )}

        {step === "hackatime" && (
          <div className="connect-step hackatime">
            <div className="connect-badge">
              <Icon name="clock" size={32} />
            </div>
            <h2 id="onboarding-title">Connect Hackatime</h2>
            <p>
              Hackatime verifies your coding identity and keeps Ranked ready to
              credit real coding activity. It is required before you can queue
              for a round.
            </p>
            <a className="primary-button" href="/api/auth/hackatime/start">
              <Icon name="clock" size={18} /> connect Hackatime
            </a>
          </div>
        )}

        {step === "placement" && (
          <>
            <h2 id="onboarding-title">How much have you built?</h2>
            <p>
              This gives you fair first matches. After a few games, your ELO
              takes over.
            </p>
            <div className="level-grid">
              {levels.map((level) => (
                <button
                  key={level.key}
                  onClick={() => onSelectExperience?.(level.key)}
                >
                  <span>
                    {Array.from({ length: level.stars }).map((_, i) => (
                      <Icon key={i} name="star" size={16} />
                    ))}
                  </span>
                  <strong>{level.title}</strong>
                  <small>{level.desc}</small>
                </button>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

type DuoInvitePartner = {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerAvatar: AvatarConfig;
  partnerQueued?: boolean;
  isCreator?: boolean;
  durationMinutes?: number;
};
type DuoInviteState = {
  partner: DuoInvitePartner | null;
  outgoing: DuoInvitePartner | null;
  incoming: DuoInvitePartner[];
};
type LobbyFriend = {
  userId: string;
  name: string;
  status: string;
  avatar: AvatarConfig;
};

function Lobby({
  navigate,
  toast,
  user,
  onMatched,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  user: NonNullable<AuthState["user"]>;
  onMatched: (match: ActiveMatch, media: MediaPrefs) => void;
}) {
  const [mode, setMode] = useState<Mode>("duo");
  const [length, setLength] = useState(30);
  const [mic, setMic] = useState(true);
  const [video, setVideo] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("");
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [matching, setMatching] = useState(false);
  const [recordingConsent, setRecordingConsent] = useState(false);
  const [matchingPhase, setMatchingPhase] = useState(
    "contacting matchmaking service…",
  );
  const [experienceOpen, setExperienceOpen] = useState(false);
  const [experience, setExperience] = useState<Experience>(
    user.experience ?? "beginner",
  );
  const [previewStream, setPreviewStream] = useState<MediaStream | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const previewVideoRef = useRef<HTMLVideoElement>(null);
  const meterFillRef = useRef<HTMLDivElement>(null);
  const [friends, setFriends] = useState<LobbyFriend[]>([]);
  const [duoState, setDuoState] = useState<DuoInviteState>({
    partner: null,
    outgoing: null,
    incoming: [],
  });
  const [inviteBusy, setInviteBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [inviteSearch, setInviteSearch] = useState("");
  const closeInvitePopover = useCallback(() => {
    setAddOpen(false);
    setInviteSearch("");
  }, []);
  useEscapeKey(addOpen, closeInvitePopover);
  const filteredFriends = friends.filter((friend) =>
    friend.name.toLowerCase().includes(inviteSearch.trim().toLowerCase()),
  );
  const [challenges, setChallenges] = useState<DashboardData["challenges"]>([]);
  const resetsIn = useCountdownToUtcMidnight();

  const acceptQueueResult = useCallback(
    (
      result: {
        status?: string;
        phase?: string;
        match?: ActiveMatch;
        error?: string;
        code?: string;
      },
      fromPoll = false,
    ) => {
      if (result.match) {
        onMatched(result.match, {
          mic,
          video,
          micDeviceId: micDeviceId || undefined,
          videoDeviceId: videoDeviceId || undefined,
        });
        return "matched" as const;
      }
      if (result.code === "vote_required") {
        setMatching(false);
        toast(result.error ?? "Vote required");
        navigate("vote");
        return "stopped" as const;
      }
      if (result.status === "queued") {
        setMatchingPhase(
          result.phase === "waiting_for_teammate"
            ? "waiting for your teammate to ready up…"
            : result.phase === "finding_teammate"
              ? "finding a compatible teammate…"
              : result.phase === "waiting_for_opponents"
                ? "team ready — finding another duo…"
                : "searching for compatible players…",
        );
        return "queued" as const;
      }
      if (result.status === "idle") {
        setMatching(false);
        setMatchingPhase("contacting matchmaking service…");
        if (fromPoll) toast("Matchmaking stopped — ready up again");
        return "stopped" as const;
      }
      return "stopped" as const;
    },
    [mic, micDeviceId, navigate, onMatched, toast, video, videoDeviceId],
  );

  // Only the duo's creator picks match settings — a joiner queues for
  // whatever duration the creator set, synced from the server, rather than
  // their own local (possibly stale) selection.
  const isDuoJoiner = Boolean(
    mode === "duo" && duoState.partner && duoState.partner.isCreator === false,
  );
  const effectiveLength =
    isDuoJoiner && duoState.partner?.durationMinutes
      ? duoState.partner.durationMinutes
      : length;
  const hasPendingDuoInvite = Boolean(
    mode === "duo" && (duoState.outgoing || duoState.incoming.length > 0),
  );

  const ready = async () => {
    if (matching) {
      setMatching(false);
      setMatchingPhase("contacting matchmaking service…");
      try {
        const { response } = await fetchJsonWithTimeout(
          "/api/matchmaking/queue",
          { method: "DELETE" },
        );
        toast(
          response.ok
            ? "Left the matchmaking queue"
            : "You left locally, but the server cleanup needs another try",
        );
      } catch {
        toast("You left locally, but the server cleanup needs another try");
      }
      return;
    }
    if (hasPendingDuoInvite) {
      toast("Respond to or cancel the pending duo invite first");
      return;
    }
    if (!recordingConsent) {
      toast("Please consent to the 10-day match recording policy first");
      return;
    }
    if (!supportedRecordingMimeType()) {
      toast(
        "This browser cannot securely record match audio/video. Try a current Chrome, Edge, Firefox, or Safari.",
      );
      return;
    }
    setMatching(true);
    setMatchingPhase("contacting matchmaking service…");
    try {
      const profile = await fetchJsonWithTimeout<{ error?: string }>(
        "/api/profile",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ experience }),
        },
      );
      if (!profile.response.ok) {
        throw new Error(profile.data.error ?? "Could not save your settings.");
      }
      const { response, data: result } = await fetchJsonWithTimeout<{
        status?: string;
        phase?: string;
        match?: ActiveMatch;
        error?: string;
        code?: string;
      }>("/api/matchmaking/queue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode,
          durationMinutes: effectiveLength,
          experience,
          recordingConsent: true,
        }),
      });
      if (result.code === "hackatime_required") {
        setMatching(false);
        window.location.assign("/api/auth/hackatime/start");
        return;
      }
      if (!response.ok && result.code !== "vote_required") {
        throw new Error(result.error ?? "Could not join the queue");
      }
      acceptQueueResult(result);
    } catch (error) {
      setMatching(false);
      setMatchingPhase("contacting matchmaking service…");
      toast(
        error instanceof Error
          ? error.message
          : "Could not join the queue — check your connection",
      );
    }
  };

  const testEmptyLobby = async () => {
    try {
      const { response, data: result } = await fetchJsonWithTimeout<{
        code?: string;
        error?: string;
        status?: string;
        phase?: string;
        match?: ActiveMatch;
      }>("/api/matchmaking/test-match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          durationMinutes: effectiveLength,
          mode,
          recordingConsent: true,
        }),
      });
      if (result.code === "hackatime_required") {
        window.location.assign("/api/auth/hackatime/start");
        return;
      }
      if (!response.ok)
        return toast(result.error ?? "Could not start a test lobby");
      acceptQueueResult(result);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not start a test lobby",
      );
    }
  };

  useEffect(() => {
    if (!matching) return;
    let cancelled = false;
    let pollTimer = 0;
    const poll = async () => {
      try {
        const { response, data } = await fetchJsonWithTimeout<{
          status?: string;
          phase?: string;
          match?: ActiveMatch;
          error?: string;
          code?: string;
        }>("/api/matchmaking/queue");
        if (cancelled) return;
        if (!response.ok) {
          setMatching(false);
          toast(data.error ?? "Matchmaking stopped — ready up again");
          return;
        }
        const state = acceptQueueResult(data, true);
        if (state === "queued" && !cancelled) {
          pollTimer = window.setTimeout(poll, 2000);
        }
      } catch (error) {
        if (cancelled) return;
        setMatching(false);
        setMatchingPhase("contacting matchmaking service…");
        toast(
          error instanceof Error
            ? `${error.message} Ready up to try again.`
            : "Matchmaking lost connection — ready up to try again",
        );
      }
    };
    pollTimer = window.setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      window.clearTimeout(pollTimer);
    };
  }, [acceptQueueResult, matching, toast]);

  // Navigating away from the lobby while queued is treated the same as
  // clicking "ready up" again to cancel — leaving the queue server-side
  // instead of leaving a stale row behind.
  const matchingRef = useRef(matching);
  useEffect(() => {
    matchingRef.current = matching;
  }, [matching]);
  useEffect(() => {
    return () => {
      if (matchingRef.current)
        void fetch("/api/matchmaking/queue", { method: "DELETE" });
    };
  }, []);
  // The unmount cleanup above only fires on in-app navigation — a closed
  // tab, hard refresh, or browser-back out of the SPA entirely tears down
  // the page before React gets to run it, leaving the queue row behind
  // indefinitely. `pagehide` fires in exactly those cases too, and
  // `keepalive` lets the request outlive the page that started it.
  useEffect(() => {
    const leaveQueueOnPageHide = () => {
      if (matchingRef.current) {
        void fetch("/api/matchmaking/queue", {
          method: "DELETE",
          keepalive: true,
        });
      }
    };
    window.addEventListener("pagehide", leaveQueueOnPageHide);
    return () => window.removeEventListener("pagehide", leaveQueueOnPageHide);
  }, []);

  // Live self-preview: mirrors Discord's device settings, a persistent camera
  // preview and mic level meter instead of a one-shot "test my setup" check.
  useEffect(() => {
    let currentStream: MediaStream | null = null;
    let cancelled = false;
    (async () => {
      if (!mic && !video) {
        setPreviewStream(null);
        return;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: mic
            ? micDeviceId
              ? { deviceId: { exact: micDeviceId } }
              : true
            : false,
          video: video
            ? videoDeviceId
              ? { deviceId: { exact: videoDeviceId } }
              : true
            : false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        currentStream = stream;
        setPreviewStream(stream);
        setPreviewError(false);
        setDevices(await navigator.mediaDevices.enumerateDevices());
      } catch {
        if (!cancelled) setPreviewError(true);
      }
    })();
    return () => {
      cancelled = true;
      currentStream?.getTracks().forEach((track) => track.stop());
    };
  }, [mic, video, micDeviceId, videoDeviceId]);

  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = video ? previewStream : null;
    }
  }, [previewStream, video]);

  useEffect(() => {
    if (!mic || !previewStream?.getAudioTracks().length) return;
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(previewStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const centered = (data[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const level = Math.min(1, Math.sqrt(sumSquares / data.length) * 4.5);
      if (meterFillRef.current)
        meterFillRef.current.style.transform = `scaleX(${level})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void audioContext.close();
    };
  }, [mic, previewStream]);

  useEffect(() => {
    fetch("/api/friends")
      .then((response) => response.json())
      .then((data) =>
        setFriends(
          (data.friends ?? []).filter(
            (friend: LobbyFriend) => friend.status === "accepted",
          ),
        ),
      )
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("/api/dashboard")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setChallenges(data.challenges ?? []))
      .catch(() => undefined);
  }, []);

  const duoPollInFlight = useRef(false);
  const fetchDuoState = useCallback(async () => {
    if (duoPollInFlight.current) return;
    duoPollInFlight.current = true;
    try {
      const { response, data } = await fetchJsonWithTimeout<
        DuoInviteState & { error?: string }
      >("/api/duo-invites", {}, 8000);
      if (!response.ok)
        throw new Error(data.error ?? "Could not load your duo");
      setDuoState(data);
    } catch {
      // The next bounded poll retries. Avoid replacing a known partner with an
      // empty state just because one request failed.
    } finally {
      duoPollInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (mode !== "duo") return;
    const initialPoll = window.setTimeout(() => void fetchDuoState(), 0);
    const poll = window.setInterval(fetchDuoState, 3000);
    return () => {
      window.clearTimeout(initialPoll);
      window.clearInterval(poll);
    };
  }, [fetchDuoState, mode]);

  const sendInvite = async (friendId: string) => {
    if (inviteBusy || matching) return;
    setInviteBusy(true);
    try {
      const { response, data: result } = await fetchJsonWithTimeout<{
        outgoing?: DuoInvitePartner;
        error?: string;
      }>("/api/duo-invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ friendId, durationMinutes: length }),
      });
      if (!response.ok || !result.outgoing)
        return toast(result.error ?? "Could not send invite");
      const outgoing = result.outgoing;
      setDuoState((current) => ({ ...current, outgoing }));
      toast(`Invite sent to ${outgoing.partnerName}`);
    } catch (error) {
      toast(
        error instanceof Error
          ? error.message
          : "Could not send invite — check your connection",
      );
    } finally {
      setInviteBusy(false);
    }
  };

  // The creator's chosen match length is the single source of truth once a
  // duo is formed — push it to the invite row whenever it changes (or the
  // instant a partner accepts) so the joiner's lobby, which can't change
  // this itself, always reflects the creator's real setting.
  const partnerInviteId = duoState.partner?.id;
  const isDuoCreator = duoState.partner?.isCreator === true;
  useEffect(() => {
    if (!isDuoCreator || !partnerInviteId) return;
    let cancelled = false;
    void fetchJsonWithTimeout<{ error?: string }>("/api/duo-invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inviteId: partnerInviteId,
        durationMinutes: length,
      }),
    })
      .then(({ response, data }) => {
        if (!cancelled && !response.ok) {
          toast(data.error ?? "Could not sync the match length");
        }
      })
      .catch(() => {
        if (!cancelled) toast("Could not sync the match length");
      });
    return () => {
      cancelled = true;
    };
  }, [isDuoCreator, partnerInviteId, length, toast]);

  const cancelDuo = async () => {
    try {
      const { response, data } = await fetchJsonWithTimeout<{ error?: string }>(
        "/api/duo-invites",
        { method: "DELETE" },
      );
      if (!response.ok)
        throw new Error(data.error ?? "Could not leave the duo");
      setMatching(false);
      setMatchingPhase("contacting matchmaking service…");
      setDuoState({ partner: null, outgoing: null, incoming: [] });
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not leave the duo");
    }
  };

  const leaveLobby = async () => {
    if (matching) {
      setMatching(false);
      await fetch("/api/matchmaking/queue", { method: "DELETE" });
    }
    navigate("home");
  };

  return (
    <main className="lobby-screen">
      <div className="lobby-top-row">
        <button className="lobby-exit-button" onClick={() => void leaveLobby()}>
          <Icon name="arrow-left" size={14} />
          leave lobby
        </button>
        <Logo compact />
        <div className="lobby-hud-chip">
          <Icon name="target" size={13} />
          <span>
            matching by <b>{experience}</b> · elo <b>{user.elo}</b>
          </span>
          <button onClick={() => setExperienceOpen(true)}>change</button>
        </div>
      </div>

      <section className="lobby-stage">
        <div className="flex flex-col gap-4">
          <DailyChallenges challenges={challenges} resetsIn={resetsIn} />

          <div className="match-dock">
            <label
              className={`recording-consent ${recordingConsent ? "accepted" : ""}`}
            >
              <input
                type="checkbox"
                checked={recordingConsent}
                onChange={(event) => setRecordingConsent(event.target.checked)}
                disabled={matching}
              />
              <span>
                <strong>audio/video recording required</strong>
                <small>{recordingConsentCopy()}</small>
              </span>
            </label>
            <button
              className={`primary-button match-dock-button ${matching ? "matching" : ""}`}
              onClick={() => void ready()}
              disabled={!matching && (hasPendingDuoInvite || !recordingConsent)}
            >
              {matching ? (
                <>
                  <i className="spinner" /> searching… tap to cancel
                </>
              ) : (
                <>
                  ready up <Icon name="external" size={16} />
                </>
              )}
            </button>
            {matching && (
              <p className="match-dock-status">
                <i className="dock-dot" /> {matchingPhase}
              </p>
            )}
            {isAdmin(user.email) && !matching && (
              <button
                className="test-lobby-button"
                onClick={() => void testEmptyLobby()}
                disabled={!recordingConsent}
              >
                enter empty lobby (test)
              </button>
            )}
          </div>
        </div>

        <section className="lobby-hero">
          <div className="pedestal-row">
            <div className={`pedestal ${matching ? "ready" : ""}`}>
              <div className="pedestal-ring" />
              <div className="pedestal-avatar">
                <ScribbleAvatar
                  avatar={user.avatar}
                  size={mode === "duo" ? "lg" : "lg"}
                />
                {matching && (
                  <span className="ready-badge">
                    <Icon name="check" size={12} />
                  </span>
                )}
              </div>
              <strong>{user.name}</strong>
            </div>
            {mode === "duo" && (
              <div
                className={`pedestal ${duoState.partner ? "" : duoState.outgoing ? "pending" : "empty"} ${duoState.partner?.partnerQueued ? "ready" : ""}`}
              >
                {duoState.partner ? (
                  <>
                    <div className="pedestal-ring" />
                    <div className="pedestal-beam" />
                    <div className="pedestal-avatar">
                      <ScribbleAvatar
                        avatar={duoState.partner.partnerAvatar}
                        size="lg"
                      />
                      {duoState.partner.partnerQueued && (
                        <span className="ready-badge">
                          <Icon name="check" size={12} />
                        </span>
                      )}
                    </div>
                    <strong>{duoState.partner.partnerName}</strong>
                    <button
                      className="invite-cancel"
                      onClick={() => void cancelDuo()}
                    >
                      {isDuoJoiner ? "leave duo" : "kick"}
                    </button>
                  </>
                ) : duoState.outgoing ? (
                  <>
                    <div className="pedestal-ring dashed" />
                    <ScribbleAvatar
                      avatar={duoState.outgoing.partnerAvatar}
                      size="md"
                    />
                    <span className="pending-badge">invited</span>
                    <strong>{duoState.outgoing.partnerName}</strong>
                    <button
                      className="invite-cancel"
                      onClick={() => void cancelDuo()}
                    >
                      cancel
                    </button>
                  </>
                ) : (
                  <>
                    <div className="pedestal-ring dashed" />
                    <button
                      type="button"
                      className="invite-plus"
                      aria-label="Invite a friend to duo"
                      aria-expanded={addOpen}
                      disabled={matching}
                      onClick={() =>
                        addOpen ? closeInvitePopover() : setAddOpen(true)
                      }
                    >
                      <Icon name="plus" size={22} />
                    </button>
                    <strong>no player yet</strong>
                    {addOpen && (
                      <>
                        <div
                          className="popover-backdrop"
                          onClick={closeInvitePopover}
                        />
                        <div
                          className="invite-popover"
                          role="dialog"
                          aria-label="Invite a friend"
                        >
                          <span className="invite-popover-title">
                            invite a friend
                          </span>
                          {friends.length > 0 && (
                            <div className="invite-search">
                              <Icon name="search" size={11} />
                              <input
                                type="text"
                                value={inviteSearch}
                                onChange={(event) =>
                                  setInviteSearch(event.target.value)
                                }
                                placeholder="search friends"
                                autoComplete="off"
                                aria-label="Search friends"
                              />
                            </div>
                          )}
                          {friends.length === 0 ? (
                            <p className="invite-empty">
                              Add friends from a recent match first.
                            </p>
                          ) : filteredFriends.length === 0 ? (
                            <p className="invite-empty">
                              No friends match &ldquo;{inviteSearch}&rdquo;.
                            </p>
                          ) : (
                            <ul className="invite-friend-list">
                              {filteredFriends.map((friend) => (
                                <li key={friend.userId}>
                                  <span className="invite-avatar-frame">
                                    <ScribbleAvatar
                                      size="sm"
                                      avatar={friend.avatar}
                                    />
                                  </span>
                                  <strong title={friend.name}>{friend.name}</strong>
                                  <button
                                    disabled={inviteBusy}
                                    onClick={() => {
                                      void sendInvite(friend.userId);
                                      closeInvitePopover();
                                    }}
                                  >
                                    invite
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </section>

        <aside className="hud-panel hud-panel-right">
          <div className={`hud-block ${isDuoJoiner ? "hud-block-locked" : ""}`}>
            <span className="hud-label">
              team size
              {isDuoJoiner && <small>set by team leader</small>}
            </span>
            <div className="segmented">
              <button
                className={mode === "solo" ? "active" : ""}
                disabled={matching || isDuoJoiner}
                onClick={() => setMode("solo")}
              >
                <Icon name="person" size={18} />
                <span>
                  solo<small>1 vs 1</small>
                </span>
              </button>
              <button
                className={mode === "duo" ? "active" : ""}
                disabled={matching || isDuoJoiner}
                onClick={() => setMode("duo")}
              >
                <Icon name="people" size={18} />
                <span>
                  duos<small>2 vs 2</small>
                </span>
              </button>
            </div>
          </div>
          <div className={`hud-block ${isDuoJoiner ? "hud-block-locked" : ""}`}>
            <span className="hud-label">
              match length
              {isDuoJoiner && <small>set by team leader</small>}
            </span>
            <div className="time-options">
              {[10, 30, 60].map((time) => (
                <button
                  key={time}
                  className={effectiveLength === time ? "active" : ""}
                  disabled={matching || isDuoJoiner}
                  onClick={() => setLength(time)}
                >
                  <strong>{time}</strong>
                  <small>min</small>
                </button>
              ))}
            </div>
          </div>
          <div className="hud-block hud-block-tight">
            <span className="hud-label">camera & microphone</span>
            <div className="camera-preview h-[20vh]">
              {video && previewStream && !previewError ? (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="camera-preview-video"
                />
              ) : (
                <div className="camera-preview-placeholder h-[20vh]">
                  <small>
                    {previewError
                      ? "Camera or mic blocked, check browser permissions"
                      : "Camera off"}
                  </small>
                </div>
              )}
              <div className="camera-preview-controls">
                <button
                  className={mic ? "on" : "off"}
                  onClick={() => setMic(!mic)}
                  aria-label={mic ? "Mute microphone" : "Unmute microphone"}
                  aria-pressed={mic}
                >
                  <Icon name={mic ? "mic" : "mic-off"} size={15} />
                </button>
                <button
                  className={video ? "on" : "off"}
                  onClick={() => setVideo(!video)}
                  aria-label={video ? "Turn camera off" : "Turn camera on"}
                  aria-pressed={video}
                >
                  <Icon name={video ? "camera" : "camera-off"} size={15} />
                </button>
              </div>
            </div>
            <div className="input-meter" aria-hidden="true">
              <span>input level</span>
              <div className="input-meter-track">
                <div
                  ref={meterFillRef}
                  className="input-meter-fill"
                  style={{ transform: "scaleX(0)" }}
                />
              </div>
            </div>
            <div className="device-row-group">
              <div className="device-row">
                <span>mic</span>
                <select
                  aria-label="Microphone"
                  value={micDeviceId}
                  onChange={(event) => setMicDeviceId(event.target.value)}
                >
                  <option value="">Default</option>
                  {devices
                    .filter((device) => device.kind === "audioinput")
                    .map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Microphone ${index + 1}`}
                      </option>
                    ))}
                </select>
              </div>
              <div className="device-row">
                <span>camera</span>
                <select
                  aria-label="Camera"
                  value={videoDeviceId}
                  onChange={(event) => setVideoDeviceId(event.target.value)}
                >
                  <option value="">Default</option>
                  {devices
                    .filter((device) => device.kind === "videoinput")
                    .map((device, index) => (
                      <option key={device.deviceId} value={device.deviceId}>
                        {device.label || `Camera ${index + 1}`}
                      </option>
                    ))}
                </select>
              </div>
            </div>
          </div>
        </aside>
      </section>

      <div className="lobby-footer">
        <small className="lobby-fineprint text-[10px] mb-2">
          By joining, you agree to abide by the{" "}
          <a
            target="_blank"
            href="https://hackclub.com/conduct"
            className="black bold underline"
          >
            Hack Club Code of Conduct
          </a>{" "}
          and be cool
        </small>
      </div>

      {experienceOpen && (
        <OnboardingModal
          step="placement"
          close={() => setExperienceOpen(false)}
          onSelectExperience={(e) => {
            setExperience(e);
            setExperienceOpen(false);
            toast(`Placement level set to ${e}`);
          }}
        />
      )}
    </main>
  );
}

// RMS-level detection, same shape as the lobby's mic-test meter (see the
// useEffect tied to previewStream/meterFillRef) — but compared against an
// adaptive noise floor instead of one fixed number. getUserMedia's default
// autoGainControl actively boosts quiet room noise, so a fixed threshold
// alone lights up on ambient hum, not just real speech; tracking how loud
// "quiet" currently is (and requiring a real jump above it) keeps this tied
// to audio the mic is actually picking up a voice on.
const SPEAKING_MIN_LEVEL = 0.02;
const SPEAKING_FLOOR_MULTIPLIER = 2.5;
const SPEAKING_HOLD_MS = 350;

function useIsSpeaking(
  stream: MediaStream | null | undefined,
  enabled: boolean,
) {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!enabled || !stream || !stream.getAudioTracks().length) return;
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let frame = 0;
    let noiseFloor = SPEAKING_MIN_LEVEL;
    let lastAboveThreshold = 0;
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let sumSquares = 0;
      for (let i = 0; i < data.length; i++) {
        const centered = (data[i] - 128) / 128;
        sumSquares += centered * centered;
      }
      const level = Math.sqrt(sumSquares / data.length);
      const now = performance.now();
      const threshold = Math.max(
        SPEAKING_MIN_LEVEL,
        noiseFloor * SPEAKING_FLOOR_MULTIPLIER,
      );
      if (level > threshold) {
        lastAboveThreshold = now;
        setSpeaking(true);
      } else {
        // Only drift the floor up while quiet, so it tracks room/AGC noise
        // without ever adapting to someone's own voice as "the new normal".
        noiseFloor = noiseFloor * 0.98 + level * 0.02;
        if (now - lastAboveThreshold > SPEAKING_HOLD_MS) setSpeaking(false);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void audioContext.close();
      setSpeaking(false);
    };
  }, [stream, enabled]);
  return speaking;
}

function VideoTile({
  name,
  team,
  avatar,
  color,
  muted = false,
  stream,
  audioSource,
  local = false,
  audioMuted = false,
  compact = false,
}: {
  name: string;
  team: string;
  avatar?: AvatarConfig;
  color?: string;
  muted?: boolean;
  stream?: MediaStream | null;
  audioSource?: MediaStream | null;
  local?: boolean;
  audioMuted?: boolean;
  compact?: boolean;
}) {
  const speaking = useIsSpeaking(audioSource ?? stream, !muted);
  return (
    <div
      className={`video-tile${compact ? " compact" : ""}${speaking ? " speaking" : ""}`}
      style={{ "--tile": color ?? avatarAccent(avatar) } as React.CSSProperties}
      title={`${name} · ${team}`}
    >
      {stream ? (
        <StreamVideo
          stream={stream}
          muted={local || audioMuted}
          label={`${name}'s live video`}
        />
      ) : (
        <ScribbleAvatar
          avatar={avatar}
          size={compact ? "sm" : "md"}
          label={`${name}'s camera placeholder`}
        />
      )}
      <div className="video-label">
        <span>
          <i />
          {name}
        </span>
        {!compact && <small>{team}</small>}
      </div>
      {muted && <span className="muted-badge">muted</span>}
    </div>
  );
}

function Match({
  navigate,
  toast,
  auth,
  match,
  media,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  match: ActiveMatch;
  media: MediaPrefs;
}) {
  const [seconds, setSeconds] = useState(() => {
    const serverSeconds = Number(match.remainingSeconds);
    return Number.isFinite(serverSeconds) && serverSeconds >= 0
      ? Math.ceil(serverSeconds)
      : match.durationMinutes * 60;
  });
  const [files, setFiles] = useState(starterFiles);
  const [fileOrder, setFileOrder] = useState<string[]>(
    Object.keys(starterFiles),
  );
  const [openTabs, setOpenTabs] = useState<string[]>(Object.keys(starterFiles));
  const [tab, setTab] = useState("index.html");
  const [addingFile, setAddingFile] = useState(false);
  const [newFileName, setNewFileName] = useState("");
  const [fileToDelete, setFileToDelete] = useState<string | null>(null);
  const [sidebarPanel, setSidebarPanel] = useState<
    "files" | "search" | "changes" | "settings" | null
  >("files");
  const [searchQuery, setSearchQuery] = useState("");
  const [revealRequest, setRevealRequest] = useState<{
    file: string;
    line: number;
  } | null>(null);
  const [editorPrefs, setEditorPrefs] = useState({
    wordWrap: true,
    minimap: false,
    fontSize: 14,
    tabSize: 2,
  });
  const [mic, setMic] = useState(media.mic);
  const [video, setVideo] = useState(media.video);
  const [scope, setScope] = useState<"team" | "everyone">("everyone");
  const [micDeviceId, setMicDeviceId] = useState(media.micDeviceId ?? "");
  const [videoDeviceId, setVideoDeviceId] = useState(media.videoDeviceId ?? "");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [avSettingsOpen, setAvSettingsOpen] = useState(false);
  const avSettingsAnchorRef = useRef<HTMLDivElement>(null);
  useOutsideDismiss(avSettingsOpen, avSettingsAnchorRef, () =>
    setAvSettingsOpen(false),
  );
  useEscapeKey(avSettingsOpen, () => setAvSettingsOpen(false));
  useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => undefined);
  }, []);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [opponentPreviewOpen, setOpponentPreviewOpen] = useState(false);
  const [opponentSnapshot, setOpponentSnapshot] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const [description, setDescription] = useState("");
  const [descriptionError, setDescriptionError] = useState<string | null>(null);
  const [forfeitOpen, setForfeitOpen] = useState(false);
  const [forfeitLoading, setForfeitLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [reportMenuOpen, setReportMenuOpen] = useState(false);
  const [reportType, setReportType] = useState<"misconduct" | "ai" | null>(
    null,
  );
  const [reportRoster, setReportRoster] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [reportRosterLoading, setReportRosterLoading] = useState(false);
  const [reportTargetId, setReportTargetId] = useState("");
  const [reportDetails, setReportDetails] = useState("");
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [reportError, setReportError] = useState<string | null>(null);
  useEscapeKey(addingFile, () => setAddingFile(false));
  useEscapeKey(Boolean(fileToDelete), () => setFileToDelete(null));
  useEscapeKey(settingsOpen, () => setSettingsOpen(false));
  useEscapeKey(reportMenuOpen, () => setReportMenuOpen(false));
  useEscapeKey(Boolean(reportType), () => setReportType(null));
  useEscapeKey(forfeitOpen, () => setForfeitOpen(false));
  const [hackatimeRecording, setHackatimeRecording] = useState<
    "ready" | "sending" | "recorded" | "error"
  >("ready");
  const lastHackatimeHeartbeatRef = useRef(0);
  const [disconnect, setDisconnect] = useState<DisconnectNotice | null>(null);
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [buildName, setBuildName] = useState("");
  const [publishState, setPublishState] = useState<{
    loading: boolean;
    error?: string;
    publicationId?: string;
    repositoryUrl?: string;
    pagesUrl?: string;
    airtableStatus?: string;
  }>({ loading: false });
  const [submissionProfile, setSubmissionProfile] = useState<{
    loading: boolean;
    ready: boolean;
  }>({ loading: true, ready: false });
  const submissionCaptureRef = useRef<HTMLIFrameElement>(null);
  const airtableAttemptedRef = useRef<string | null>(null);
  const {
    ready: pagesReady,
    secondsLeft: pagesCountdown,
    stalled: pagesStalled,
  } = usePagesReady(publishState.pagesUrl);
  const team = match.team;
  const onPeerVideoLost = useCallback(
    (peer: PeerVideoLost) => {
      toast(
        peer.team === team
          ? `${peer.name}'s video disconnected`
          : `${peer.name}'s video disconnected`,
      );
    },
    [team, toast],
  );
  const { status, localStream, remotePeers } = useRealtimeRoom(
    `ranked:call:${match.id}`,
    mic,
    video,
    scope,
    team,
    micDeviceId || undefined,
    videoDeviceId || undefined,
    onPeerVideoLost,
  );
  const { status: recordingStatus, error: recordingError } = useMatchRecording(
    match.id,
    localStream,
    seconds > 0 && !outcome,
  );
  const room = useCodeRoom(`ranked:code:${match.id}:${team}`);
  // The call room is one shared room for the whole match (both teams, so
  // opponents can join with "everyone" scope) — remotePeers includes them
  // regardless of the call scope setting. The code room is a separate room
  // scoped per-team, so it only ever contains your actual teammate. The
  // "X editing" indicator (and its face-stack) describes who's really
  // sharing this code, not who's in the call — filtering to teammates
  // keeps it correct in duo (and correctly just "1 editing" in solo,
  // instead of counting an opponent who can't see this code at all).
  const codeCollaborators = remotePeers.filter((peer) => peer.team === team);

  useEffect(() => {
    if (!publishOpen && !publishState.repositoryUrl) return;
    let cancelled = false;
    fetch("/api/airtable/profile")
      .then(async (response) => {
        const result = (await response.json()) as { ready?: boolean };
        if (!response.ok) throw new Error("Could not load HCA profile");
        return result;
      })
      .then((result) => {
        if (cancelled) return;
        setSubmissionProfile({ loading: false, ready: result.ready === true });
      })
      .catch(() => {
        if (!cancelled) {
          setSubmissionProfile({ loading: false, ready: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [publishOpen, publishState.repositoryUrl]);

  useEffect(() => {
    if (status === "media-blocked") {
      toast("Camera/mic blocked — check your browser permissions and rejoin");
    }
  }, [status, toast]);

  useEffect(() => {
    if (recordingError) toast(`Recording problem: ${recordingError}`);
  }, [recordingError, toast]);

  useEffect(() => {
    if (!room) return;
    const provider = getYjsProviderForRoom(room, {
      offlineSupport_experimental: true,
    });
    const doc = provider.getYDoc();
    const fileList = doc.getArray<string>("file-list");
    const tracked = new Map<
      string,
      { text: ReturnType<typeof doc.getText>; sync: () => void }
    >();
    let tabsSeeded = false;

    const trackFile = (name: string) => {
      if (tracked.has(name)) return;
      const text = doc.getText(`file:${name}`);
      const sync = () =>
        setFiles((current) =>
          text.length ? { ...current, [name]: text.toString() } : current,
        );
      text.observe(sync);
      tracked.set(name, { text, sync });
      if (text.length) sync();
    };

    const syncFileOrder = () => {
      // Dedupes defensively: a duo room briefly had two peers race to seed
      // before the leader-election below existed, and this keeps any match
      // still carrying that leftover doubled file-list from ever rendering
      // duplicate tabs, regardless of what's physically in the Yjs array.
      const names = [...new Set(fileList.toArray())];
      const resolved = names.length ? names : Object.keys(starterFiles);
      setFileOrder(resolved);
      setOpenTabs((current) =>
        tabsSeeded
          ? current.filter((name) => resolved.includes(name))
          : resolved,
      );
      for (const name of names) trackFile(name);
    };

    const writeSeed = () => {
      doc.transact(() => {
        for (const name of Object.keys(starterFiles)) fileList.push([name]);
      });
      syncFileOrder();
      tabsSeeded = true;
      doc.transact(() => {
        for (const name of fileList.toArray()) {
          const text = tracked.get(name)?.text ?? doc.getText(`file:${name}`);
          if (!text.length && starterFiles[name])
            text.insert(0, starterFiles[name]);
        }
      });
      for (const { sync } of tracked.values()) sync();
    };

    // Solo matches never contend for this: only one player is ever in a
    // given team's code room, so there's no one to race against — seed the
    // moment Yjs is synced, same as before.
    //
    // Duo matches share one code room between both teammates, who both
    // land here within moments of each other. Yjs doesn't dedupe concurrent
    // writes from different clients — if both independently found the file
    // list empty and both seeded, the list gets every filename twice and
    // each file's text gets its starter content inserted twice. Electing a
    // single seeder (the connection with the lowest connectionId — the same
    // ordering already used for WebRTC's "polite peer" role in
    // useRealtimeRoom) makes this deterministic instead of racy: only that
    // one client ever writes the seed, the other just waits for it to sync.
    // The 1.2s delay gives Liveblocks presence time to actually report the
    // teammate before either side commits to a decision — deciding on an
    // empty `getOthers()` too early would have both sides concluding
    // they're alone and seeding anyway.
    let seedTimer: number | undefined;
    let retryTimer: number | undefined;

    const attemptSeed = () => {
      if (tabsSeeded || fileList.length > 0) {
        syncFileOrder();
        tabsSeeded = true;
        return;
      }
      const self = room.getSelf();
      if (!self) {
        retryTimer = window.setTimeout(attemptSeed, 300);
        return;
      }
      const iAmSeeder = room
        .getOthers()
        .every((other) => other.connectionId > self.connectionId);
      if (iAmSeeder) writeSeed();
      else {
        syncFileOrder();
        tabsSeeded = true;
      }
    };

    const seedAll = (synced: boolean) => {
      if (!synced || tabsSeeded) return;
      window.clearTimeout(seedTimer);
      if (match.mode === "duo")
        seedTimer = window.setTimeout(attemptSeed, 1200);
      else attemptSeed();
    };

    fileList.observe(syncFileOrder);
    syncFileOrder();
    provider.on("sync", seedAll);
    seedAll(provider.synced);
    return () => {
      window.clearTimeout(seedTimer);
      window.clearTimeout(retryTimer);
      fileList.unobserve(syncFileOrder);
      provider.off("sync", seedAll);
      for (const { text, sync } of tracked.values()) text.unobserve(sync);
    };
  }, [room, match.mode]);

  const addFile = useCallback(
    (rawName: string) => {
      const name = rawName.trim();
      if (!FILE_NAME_PATTERN.test(name)) {
        toast("File names must look like name.html, name.css, or name.js");
        return;
      }
      if (fileOrder.includes(name)) {
        toast("A file with that name already exists");
        return;
      }
      if (!room) return;
      const provider = getYjsProviderForRoom(room, {
        offlineSupport_experimental: true,
      });
      const doc = provider.getYDoc();
      const fileList = doc.getArray<string>("file-list");
      if (fileList.toArray().includes(name)) return;
      const ext = name.split(".").pop() as "html" | "css" | "js";
      doc.transact(() => {
        fileList.push([name]);
        const text = doc.getText(`file:${name}`);
        if (text.length === 0) text.insert(0, FILE_TEMPLATES[ext]);
      });
      setOpenTabs((current) =>
        current.includes(name) ? current : [...current, name],
      );
      setTab(name);
      setAddingFile(false);
      setNewFileName("");
    },
    [fileOrder, room, toast],
  );

  const openFile = useCallback((name: string) => {
    setOpenTabs((current) =>
      current.includes(name) ? current : [...current, name],
    );
    setTab(name);
  }, []);

  const closeTab = useCallback(
    (name: string) => {
      if (openTabs.length <= 1) return;
      const index = openTabs.indexOf(name);
      if (index === -1) return;
      const next = openTabs.filter((f) => f !== name);
      setOpenTabs(next);
      if (tab === name) setTab(next[index - 1] ?? next[0]);
    },
    [openTabs, tab],
  );

  const removeFile = useCallback(
    (name: string) => {
      if (name === "index.html" || !room) return;
      const provider = getYjsProviderForRoom(room, {
        offlineSupport_experimental: true,
      });
      const doc = provider.getYDoc();
      const fileList = doc.getArray<string>("file-list");
      const index = fileList.toArray().indexOf(name);
      if (index !== -1) fileList.delete(index, 1);
      const wasActive = tab === name;
      setOpenTabs((current) => {
        const next = current.filter((f) => f !== name);
        return wasActive && !next.includes("index.html")
          ? [...next, "index.html"]
          : next;
      });
      if (wasActive) setTab("index.html");
    },
    [room, tab],
  );

  const confirmDeleteFile = () => {
    if (fileToDelete) removeFile(fileToDelete);
    setFileToDelete(null);
  };

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((s) => Math.max(0, s - 1));
      setDisconnect((current) =>
        current
          ? {
              ...current,
              secondsRemaining: Math.max(0, current.secondsRemaining - 1),
            }
          : null,
      );
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const [previewPage, setPreviewPage] = useState<string | null>(null);
  const [tabForPreviewReset, setTabForPreviewReset] = useState(tab);
  if (tab !== tabForPreviewReset) {
    setTabForPreviewReset(tab);
    setPreviewPage(null);
  }
  const activeHtmlFile = useMemo(
    () =>
      previewPage && files[previewPage] !== undefined
        ? previewPage
        : tab.endsWith(".html") && files[tab] !== undefined
          ? tab
          : "index.html",
    [previewPage, tab, files],
  );
  const previewDoc = useMemo(
    () => buildPage(files, fileOrder, activeHtmlFile, { preview: true }),
    [files, fileOrder, activeHtmlFile],
  );
  const previewDocRef = useRef(previewDoc);
  useEffect(() => {
    previewDocRef.current = previewDoc;
  }, [previewDoc]);
  // The snapshot an opponent sees mid-match intentionally follows whatever
  // page you're actively working on (a live peek at your progress). But once
  // the match is over, that page is a coding-session accident, not the site
  // — the opponent's final preview (and the results-screen comparison) should
  // anchor to index.html regardless of what page either of you last had open.
  const finalPreviewDoc = useMemo(
    () => buildPage(files, fileOrder, "index.html", { preview: true }),
    [files, fileOrder],
  );
  const finalPreviewDocRef = useRef(finalPreviewDoc);
  useEffect(() => {
    finalPreviewDocRef.current = finalPreviewDoc;
  }, [finalPreviewDoc]);
  const matchEndedRef = useRef(seconds === 0);
  useEffect(() => {
    if (seconds === 0) matchEndedRef.current = true;
  }, [seconds]);
  const ownPreviewFrames = useRef<Set<Window>>(new Set());
  const registerOwnPreviewFrame = useCallback(
    (el: HTMLIFrameElement | null) => {
      if (!el?.contentWindow) return;
      ownPreviewFrames.current.add(el.contentWindow);
      // The debounced push below only fires when content changes, so a frame
      // that mounts *after* the last change (e.g. opening the expanded
      // preview once typing has settled) would otherwise never catch up to
      // what's already been typed — it'd be stuck on whatever srcDoc had at
      // that exact moment, forever. Catching it up on its own load event
      // (rather than immediately) ensures the frame's message listener is
      // actually registered before this arrives.
      el.addEventListener("load", () => {
        el.contentWindow?.postMessage(
          {
            source: "ranked-preview",
            type: "update",
            html: previewDocRef.current,
          },
          "*",
        );
      });
    },
    [],
  );
  // The iframe's srcDoc is only reset when the active page actually changes
  // (a real "navigate to a different page" moment, where a fresh load reads
  // as expected) — never on every keystroke. In-between, updated content is
  // patched into the already-loaded document over postMessage (handled by
  // the liveUpdateShim in buildNavShim) so typing never flashes the page.
  const [iframeSrcDoc, setIframeSrcDoc] = useState(previewDoc);
  const [lastPreviewFile, setLastPreviewFile] = useState(activeHtmlFile);
  if (activeHtmlFile !== lastPreviewFile) {
    setLastPreviewFile(activeHtmlFile);
    setIframeSrcDoc(previewDoc);
  }
  // Tracks what the iframe's document last actually reflects — reset
  // whenever iframeSrcDoc itself changes (a real navigation already carried
  // the latest content), so the debounced push below only fires for content
  // that arrived *after* that point.
  const lastPushedPreviewRef = useRef(iframeSrcDoc);
  useEffect(() => {
    lastPushedPreviewRef.current = iframeSrcDoc;
  }, [iframeSrcDoc]);
  const debounceTimerRef = useRef<number | undefined>(undefined);
  const maxWaitTimerRef = useRef<number | undefined>(undefined);
  const pushPreviewUpdate = useCallback(() => {
    window.clearTimeout(debounceTimerRef.current);
    window.clearTimeout(maxWaitTimerRef.current);
    debounceTimerRef.current = undefined;
    maxWaitTimerRef.current = undefined;
    const latest = previewDocRef.current;
    if (latest === lastPushedPreviewRef.current) return;
    lastPushedPreviewRef.current = latest;
    for (const win of ownPreviewFrames.current) {
      win.postMessage(
        { source: "ranked-preview", type: "update", html: latest },
        "*",
      );
    }
  }, []);
  // Pushes shortly after typing actually pauses, rather than on a fixed
  // clock — noticeably snappier for normal typing (short pauses between
  // words/lines) than waiting out a fixed interval, while still not pushing
  // on every single keystroke. maxWaitTimer is a ceiling for someone typing
  // continuously without a long enough pause: it starts on the first edit
  // of a burst and isn't reset by subsequent keystrokes, so a fast typist
  // still sees occasional updates instead of none until they stop.
  useEffect(() => {
    window.clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = window.setTimeout(pushPreviewUpdate, 400);
    if (maxWaitTimerRef.current === undefined) {
      maxWaitTimerRef.current = window.setTimeout(pushPreviewUpdate, 2000);
    }
    return () => window.clearTimeout(debounceTimerRef.current);
  }, [previewDoc, pushPreviewUpdate]);
  useEffect(() => {
    function handleNavigateMessage(event: MessageEvent) {
      if (
        event.data?.source !== "ranked-preview" ||
        event.data?.type !== "navigate" ||
        !ownPreviewFrames.current.has(event.source as Window)
      ) {
        return;
      }
      const page = event.data.page;
      if (typeof page === "string" && files[page] !== undefined) {
        setPreviewPage(page);
      }
    }
    window.addEventListener("message", handleNavigateMessage);
    return () => window.removeEventListener("message", handleNavigateMessage);
  }, [files]);
  const searchResults = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query.length < 2) return [];
    return fileOrder
      .map((file) => ({
        file,
        matches: (files[file] ?? "")
          .split("\n")
          .map((text, index) => ({ line: index + 1, text: text.trim() }))
          .filter(({ text }) => text.toLowerCase().includes(query))
          .slice(0, 30),
      }))
      .filter((group) => group.matches.length > 0);
  }, [files, fileOrder, searchQuery]);
  const changedFiles = useMemo(
    () =>
      fileOrder.filter((file) => {
        const original =
          starterFiles[file] ??
          FILE_TEMPLATES[
            (file.split(".").pop() as "html" | "css" | "js") ?? "html"
          ];
        return files[file] !== original;
      }),
    [files, fileOrder],
  );
  const updateCurrentFile = useCallback(
    (value: string) => {
      setFiles((current) => ({ ...current, [tab]: value }));
    },
    [tab],
  );
  const reportHackatimeActivity = useCallback(
    async (activity: {
      file: string;
      lines: number;
      line: number;
      cursorPosition: number;
    }) => {
      const now = Date.now();
      if (now - lastHackatimeHeartbeatRef.current < 30_000) return;
      lastHackatimeHeartbeatRef.current = now;
      setHackatimeRecording("sending");
      try {
        const response = await fetch("/api/hackatime/heartbeat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ matchId: match.id, ...activity }),
        });
        const result = (await response.json()) as {
          error?: string;
          code?: string;
        };
        if (!response.ok) throw Object.assign(new Error(result.error), result);
        setHackatimeRecording("recorded");
      } catch (error) {
        setHackatimeRecording("error");
        if (
          typeof error === "object" &&
          error &&
          "code" in error &&
          error.code === "hackatime_reconnect"
        ) {
          toast("Hackatime disconnected — reconnect before your next round");
        }
      }
    },
    [match.id, toast],
  );

  const publish = useCallback(async () => {
    if (publishState.loading || publishState.repositoryUrl) return;
    if (
      !/^[A-Za-z0-9._-]{1,100}$/.test(buildName) ||
      buildName === "." ||
      buildName === ".."
    ) {
      setPublishState({
        loading: false,
        error:
          "Use letters, numbers, periods, underscores, or hyphens for the build name.",
      });
      return;
    }
    if (!auth.github) {
      window.location.assign("/api/auth/github/start");
      return;
    }
    if (!submissionProfile.ready) {
      setPublishState({
        loading: false,
        error: "Reconnect Hack Club Auth so Ranked can find your shipping address.",
      });
      return;
    }
    setPublishState({ loading: true });
    try {
      const pages = Object.fromEntries(
        fileOrder
          .filter((name) => name.endsWith(".html"))
          .map((name) => [name, buildPage(files, fileOrder, name)]),
      );
      const response = await fetch("/api/github/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId: match.id,
          name: buildName,
          pages,
          files,
          description,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        code?: string;
        publicationId?: string;
        repositoryUrl?: string;
        pagesUrl?: string;
        airtableStatus?: string;
      };
      if (result.code === "hca_profile_required") {
        window.location.assign("/api/auth/hackclub/start");
        return;
      }
      if (!response.ok || !result.repositoryUrl || !result.pagesUrl)
        throw new Error(result.error ?? "Publishing failed.");
      setPublishState({
        loading: false,
        publicationId: result.publicationId,
        repositoryUrl: result.repositoryUrl,
        pagesUrl: result.pagesUrl,
        airtableStatus: result.airtableStatus,
      });
      toast(`Published ${buildName}, GitHub Pages is building now`);
    } catch (error) {
      setPublishState({
        loading: false,
        error: error instanceof Error ? error.message : "Publishing failed.",
      });
    }
  }, [
    auth.github,
    files,
    fileOrder,
    match.id,
    publishState.loading,
    publishState.repositoryUrl,
    buildName,
    description,
    submissionProfile.ready,
    toast,
  ]);

  // Captures the finished build and submits it to Airtable without blocking
  // the player on it. Kicked off once GitHub Pages is actually live, the
  // screenshot has been grabbed, and there's a valid postal address to ship
  // to — then the upload itself keeps retrying quietly in the background
  // (independent of this component) since a request can still transiently
  // fail after all of that is true, and the player is free to navigate away
  // before it finishes.
  const submitToAirtable = useCallback(async () => {
    const publicationId = publishState.publicationId;
    if (!publicationId) return;
    const frame = submissionCaptureRef.current;
    const captureDocument = frame?.contentDocument;
    if (!captureDocument?.body || !captureDocument.documentElement) return;
    captureDocument.documentElement.style.width = "1200px";
    captureDocument.documentElement.style.height = "675px";
    captureDocument.body.style.width = "1200px";
    captureDocument.body.style.minHeight = "675px";
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const { toBlob } = await import("html-to-image");
    const screenshot = await toBlob(captureDocument.body, {
      width: 1200,
      height: 675,
      canvasWidth: 1200,
      canvasHeight: 675,
      backgroundColor: "#fffdf2",
      cacheBust: true,
      pixelRatio: 1,
      skipFonts: true,
    }).catch(() => null);
    if (!screenshot) return;
    const file = new File([screenshot], "ranked-build.png", {
      type: "image/png",
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const body = new FormData();
        body.set("publicationId", publicationId);
        body.set("screenshot", file);
        const response = await fetch("/api/airtable/submissions", {
          method: "POST",
          body,
        });
        if (response.status === 202) {
          await new Promise((resolve) => window.setTimeout(resolve, 5000));
          continue;
        }
        return;
      } catch {
        return;
      }
    }
  }, [publishState.publicationId]);

  useEffect(() => {
    const publicationId = publishState.publicationId;
    if (
      !publicationId ||
      !pagesReady ||
      !submissionProfile.ready ||
      airtableAttemptedRef.current === publicationId
    )
      return;
    airtableAttemptedRef.current = publicationId;
    void submitToAirtable();
  }, [
    publishState.publicationId,
    pagesReady,
    submissionProfile.ready,
    submitToAirtable,
  ]);

  const applyLifecycle = useCallback(
    (result: {
      match?: MatchOutcome | null;
      disconnect?: DisconnectNotice | null;
    }) => {
      setDisconnect(result.disconnect ?? null);
      if (
        result.match &&
        Number.isFinite(Number(result.match.remainingSeconds))
      ) {
        setSeconds(
          Math.max(0, Math.ceil(Number(result.match.remainingSeconds))),
        );
      }
      if (
        result.match?.status === "completed" &&
        ["forfeit", "disconnect"].includes(result.match.endReason ?? "")
      ) {
        setOutcome(result.match);
        setPublishOpen(false);
        setForfeitOpen(false);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const heartbeat = async () => {
      try {
        const response = await fetch(`/api/matches/${match.id}/heartbeat`, {
          method: "POST",
        });
        if (!response.ok || cancelled) return;
        applyLifecycle(await response.json());
      } catch {}
    };
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyLifecycle, match.id]);

  useEffect(() => {
    const markDisconnected = () => {
      navigator.sendBeacon(`/api/matches/${match.id}/presence`);
    };
    window.addEventListener("pagehide", markDisconnected);
    return () => window.removeEventListener("pagehide", markDisconnected);
  }, [match.id]);

  const forfeit = useCallback(async () => {
    if (forfeitLoading || outcome) return;
    setForfeitLoading(true);
    try {
      const response = await fetch(`/api/matches/${match.id}/forfeit`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        error?: string;
        match?: MatchOutcome | null;
      };
      if (!response.ok && result.match?.status !== "completed")
        throw new Error(result.error ?? "Could not forfeit the match.");
      applyLifecycle(result);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not forfeit the match.",
      );
    } finally {
      setForfeitLoading(false);
    }
  }, [applyLifecycle, forfeitLoading, match.id, outcome, toast]);

  const forceEndTimer = useCallback(async () => {
    try {
      const response = await fetch(`/api/matches/${match.id}/end-timer`, {
        method: "POST",
      });
      const result = (await response.json()) as {
        error?: string;
        match?: MatchOutcome | null;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Could not end the timer.");
      applyLifecycle(result);
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "Could not end the timer.",
      );
    }
  }, [applyLifecycle, match.id, toast]);

  const openReport = useCallback(
    async (type: "misconduct" | "ai") => {
      setReportMenuOpen(false);
      setReportType(type);
      setReportTargetId("");
      setReportDetails("");
      setReportError(null);
      setReportRoster([]);
      setReportRosterLoading(true);
      const roster = await fetch(`/api/matches/${match.id}`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const players = (roster?.players ?? []) as Array<{
        id: string;
        name: string;
      }>;
      setReportRoster(players.filter((player) => player.id !== auth.user?.id));
      setReportRosterLoading(false);
    },
    [auth.user?.id, match.id],
  );

  const submitReport = useCallback(async () => {
    if (!reportType || reportSubmitting) return;
    if (!reportTargetId) {
      setReportError("Choose who you're reporting.");
      return;
    }
    setReportSubmitting(true);
    try {
      const response = await fetch(`/api/matches/${match.id}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: reportType,
          targetId: reportTargetId,
          details: reportDetails,
        }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok)
        throw new Error(result.error ?? "Could not submit the report.");
      setReportType(null);
      toast("Report submitted — our team will review it.");
    } catch (error) {
      setReportError(
        error instanceof Error ? error.message : "Could not submit the report.",
      );
    } finally {
      setReportSubmitting(false);
    }
  }, [
    match.id,
    reportDetails,
    reportSubmitting,
    reportTargetId,
    reportType,
    toast,
  ]);

  useEffect(() => {
    if (!previewOpen && !opponentPreviewOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setPreviewOpen(false);
      setOpponentPreviewOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewOpen, opponentPreviewOpen]);

  const postSnapshot = useCallback(
    async (html: string) => {
      // The opponent's snapshot rides back on the same response as the write
      // (see snapshot/route.ts), so one request covers a full sync tick
      // instead of a POST followed by a separate GET.
      const response = await fetch(`/api/matches/${match.id}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html }),
      });
      if (!response.ok) return;
      const result = (await response.json()) as {
        snapshot?: { html?: string } | null;
      };
      if (result.snapshot?.html) setOpponentSnapshot(result.snapshot.html);
    },
    [match.id],
  );

  useEffect(() => {
    const sync = () =>
      postSnapshot(
        matchEndedRef.current
          ? finalPreviewDocRef.current
          : previewDocRef.current,
      );
    const initial = window.setTimeout(() => void sync(), 1000);
    // Fast enough that the opponent panel reads as close to live; 3s already
    // matches the cadence the duo-state poll runs at elsewhere in this app
    // without issue, and folding the GET into the POST above keeps this from
    // doubling request volume on top of the faster tick.
    const interval = window.setInterval(() => void sync(), 3_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [postSnapshot]);

  // The periodic sync above can take up to a few seconds to catch up once
  // the timer hits zero, which is long enough that the results screen
  // (opened right after) would still show a stale mid-match snapshot. Push
  // the index.html-anchored one immediately instead of waiting for that tick.
  const matchJustEnded = seconds === 0;
  useEffect(() => {
    if (!matchJustEnded) return;
    void postSnapshot(finalPreviewDocRef.current);
  }, [matchJustEnded, postSnapshot]);

  useEffect(() => {
    if (seconds === 0 && !outcome)
      window.setTimeout(() => setDescriptionOpen(true), 0);
  }, [outcome, seconds]);

  const submitDescription = () => {
    const trimmed = description.trim();
    if (trimmed.length < 30) {
      setDescriptionError("must be at least 2 sentences!");
      return;
    }
    setDescription(trimmed);
    setDescriptionError(null);
    setDescriptionOpen(false);
    setResultsOpen(true);
  };

  const isTestMatch = Boolean(match.isTest);
  const canSkipPublish = isTestMatch && isAdmin(auth.user?.email);
  const canForceEndTimer = isAdmin(auth.user?.email);

  const disconnectSeconds = disconnect
    ? Math.max(0, disconnect.secondsRemaining)
    : 0;
  const disconnectLabel =
    disconnect?.team === team
      ? match.mode === "duo"
        ? "Your teammate disconnected"
        : "Your connection is unstable"
      : "An opponent disconnected";

  const teammate = remotePeers.find((peer) => peer.team === team);
  const opponents = remotePeers
    .filter((peer) => peer.team !== team)
    .slice(0, 2);

  return (
    <main className="match-screen">
      <header className="match-header">
        <div className="match-header-brand">
          <Logo compact />
        </div>
        <div className="match-hud">
          <div className="call-team">
            <div className="call-tiles">
              <VideoTile
                compact
                name={auth.user?.name ?? "you"}
                team={`${team} · you`}
                avatar={auth.user?.avatar}
                stream={video ? localStream : null}
                audioSource={localStream}
                local
                muted={!mic}
              />
              {match.mode === "duo" && (
                <VideoTile
                  compact
                  name={teammate?.name ?? "waiting…"}
                  team={teammate ? "teammate · live" : "waiting for teammate"}
                  color={teammate?.color ?? COLORS[0]}
                  avatar={teammate?.avatar}
                  stream={teammate?.video ? teammate.stream : null}
                  audioSource={teammate?.stream}
                  muted={teammate ? !teammate.mic : false}
                />
              )}
            </div>
          </div>
          <div className="match-actions">
            <div
              className={`match-recording-indicator ${recordingStatus}`}
              role="status"
              title="This match is currently being recorded"
            >
              <i />
              <span>
                {recordingStatus === "error" ||
                recordingStatus === "unsupported"
                  ? "REC ERROR"
                  : "REC"}
              </span>
            </div>
            <button
              className="settings-gear"
              onClick={() => setSettingsOpen(true)}
              aria-label="Match settings"
            >
              <Icon name="settings" size={17} />
            </button>
            <div className="report-menu-anchor">
              <button
                className="report-menu-button"
                onClick={() => setReportMenuOpen((open) => !open)}
                aria-label="Report options"
                aria-expanded={reportMenuOpen}
              >
                <Icon name="more" size={17} />
              </button>
              {reportMenuOpen && (
                <>
                  <div
                    className="popover-backdrop"
                    onClick={() => setReportMenuOpen(false)}
                  />
                  <div className="report-menu" role="menu">
                    <button
                      role="menuitem"
                      onClick={() => void openReport("misconduct")}
                    >
                      <Icon name="flag" size={13} /> report misconduct
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => void openReport("ai")}
                    >
                      <Icon name="flag" size={13} /> report AI-generated code
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          <div className="match-timer-cluster">
            <div className="theme-tag">
              <span>theme</span>
              <strong title={match.theme}>{match.theme}</strong>
            </div>
            <div className="timer" aria-label={`${time} remaining`}>
              <span>{time}</span>
              <small>remaining</small>
            </div>
          </div>
          <div className="call-team">
            <div className="call-tiles">
              {(match.mode === "duo" ? [0, 1] : [0]).map((index) => {
                const peer = opponents[index];
                return (
                  <VideoTile
                    compact
                    key={peer?.connectionId ?? index}
                    name={peer?.name ?? "no player yet"}
                    team={peer ? `${peer.team} team` : "waiting for player"}
                    color={peer?.color ?? COLORS[index + 3]}
                    avatar={peer?.avatar}
                    stream={peer?.video ? peer.stream : null}
                    audioSource={peer?.stream}
                    muted={peer ? !peer.mic : false}
                    audioMuted={scope === "team" && peer?.team !== team}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </header>
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="modal settings-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="close-button"
              onClick={() => setSettingsOpen(false)}
              aria-label="Close settings"
            >
              ×
            </button>
            <h2>Settings</h2>
            <button
              className="danger-button"
              onClick={() => {
                setSettingsOpen(false);
                setForfeitOpen(true);
              }}
              disabled={Boolean(outcome) || forfeitLoading}
            >
              forfeit match
            </button>
            {canForceEndTimer && (
              <button
                className="danger-button"
                onClick={() => {
                  setSettingsOpen(false);
                  void forceEndTimer();
                }}
                disabled={Boolean(outcome) || seconds === 0}
              >
                force timer to end
              </button>
            )}
          </section>
        </div>
      )}
      {reportType && (
        <div className="modal-backdrop" onClick={() => setReportType(null)}>
          <section
            className="modal report-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="close-button"
              onClick={() => setReportType(null)}
              aria-label="Close report"
            >
              ×
            </button>
            <h2>
              Who are you reporting for{" "}
              {reportType === "misconduct" ? "misconduct" : "AI-generated code"}
              ?
            </h2>
            {reportRosterLoading ? (
              <p>Loading match roster…</p>
            ) : reportRoster.length ? (
              <div className="report-roster">
                {reportRoster.map((player) => (
                  <button
                    key={player.id}
                    type="button"
                    className={reportTargetId === player.id ? "active" : ""}
                    onClick={() => {
                      setReportTargetId(player.id);
                      if (reportError) setReportError(null);
                    }}
                  >
                    {player.name}
                  </button>
                ))}
              </div>
            ) : (
              <p>There&apos;s no one else in this match to report.</p>
            )}
            <label className="description-field">
              <textarea
                value={reportDetails}
                onChange={(event) =>
                  setReportDetails(event.target.value.slice(0, 1000))
                }
                placeholder={
                  reportType === "misconduct"
                    ? "What happened?"
                    : "What made you suspect AI-generated code?"
                }
                rows={4}
                maxLength={1000}
              />
              <span className="description-count">
                {reportDetails.length}/1000
              </span>
            </label>
            {reportError && <p className="publish-error">{reportError}</p>}
            <button
              className="danger-button"
              onClick={() => void submitReport()}
              disabled={reportSubmitting || !reportTargetId}
            >
              {reportSubmitting ? "submitting…" : "submit report"}
            </button>
          </section>
        </div>
      )}
      {fileToDelete && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="delete-file-title"
          onClick={() => setFileToDelete(null)}
        >
          <section
            className="modal publish-modal file-delete-modal"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-file-title">Delete {fileToDelete}?</h2>
            <p>This removes it for the whole team and can&apos;t be undone.</p>
            <div className="forfeit-actions">
              <button onClick={() => setFileToDelete(null)}>cancel</button>
              <button className="danger-button" onClick={confirmDeleteFile}>
                delete file
              </button>
            </div>
          </section>
        </div>
      )}
      {disconnect && !outcome && (
        <div
          className={`disconnect-banner ${disconnect.team === team ? "danger" : ""}`}
          role="status"
        >
          <strong>{disconnectLabel}</strong>
          <span>
            {disconnectSeconds}s to reconnect before{" "}
            {disconnect.team === team ? "your team forfeits" : "the match ends"}
          </span>
        </div>
      )}
      <section className="workspace">
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="file-tabs">
              {openTabs.map((file) => (
                <button
                  key={file}
                  onClick={() => setTab(file)}
                  className={tab === file ? "active" : ""}
                >
                  <i className={`file-dot ${file.split(".").pop()}`} />
                  {file}
                  {openTabs.length > 1 && (
                    <span
                      className="close-tab"
                      role="button"
                      aria-label={`Close ${file}`}
                      title="Close (doesn't delete the file)"
                      onClick={(event) => {
                        event.stopPropagation();
                        closeTab(file);
                      }}
                    >
                      ×
                    </span>
                  )}
                </button>
              ))}
              {addingFile ? (
                <form
                  className="new-file-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    addFile(newFileName);
                  }}
                >
                  <input
                    autoFocus
                    value={newFileName}
                    onChange={(event) => setNewFileName(event.target.value)}
                    onBlur={() => {
                      if (!newFileName) setAddingFile(false);
                    }}
                    placeholder="name.html"
                    maxLength={60}
                  />
                </form>
              ) : (
                <button
                  className="add-file-button"
                  onClick={() => setAddingFile(true)}
                  aria-label="Add file"
                >
                  +
                </button>
              )}
            </div>
            <div className="collab-state">
              <div className="face-stack">
                <i>{auth.user?.name?.[0] ?? "Y"}</i>
                {codeCollaborators.slice(0, 2).map((peer) => (
                  <i key={peer.connectionId}>{peer.name[0]}</i>
                ))}
              </div>
              <span>{codeCollaborators.length + 1} editing</span>
              <b>{status === "connected" ? "synced" : status}</b>
            </div>
          </div>
          <div
            className={`editor-area ${sidebarPanel ? `panel-open panel-${sidebarPanel}` : ""}`}
          >
            <aside className="file-rail">
              <button
                className={sidebarPanel === "files" ? "active" : ""}
                aria-label="Explorer"
                aria-pressed={sidebarPanel === "files"}
                onClick={() =>
                  setSidebarPanel((current) =>
                    current === "files" ? null : "files",
                  )
                }
              >
                <Icon name="files" size={17} />
              </button>
              <button
                className={sidebarPanel === "search" ? "active" : ""}
                aria-label="Search"
                aria-pressed={sidebarPanel === "search"}
                onClick={() =>
                  setSidebarPanel((current) =>
                    current === "search" ? null : "search",
                  )
                }
              >
                <Icon name="search" size={17} />
              </button>
              <button
                className={sidebarPanel === "changes" ? "active" : ""}
                aria-label="Source control"
                aria-pressed={sidebarPanel === "changes"}
                onClick={() =>
                  setSidebarPanel((current) =>
                    current === "changes" ? null : "changes",
                  )
                }
              >
                <Icon name="branch" size={17} />
                {changedFiles.length > 0 && (
                  <i className="rail-badge">{changedFiles.length}</i>
                )}
              </button>
              <span />
              <button
                className={sidebarPanel === "settings" ? "active" : ""}
                aria-label="Editor settings"
                aria-pressed={sidebarPanel === "settings"}
                onClick={() =>
                  setSidebarPanel((current) =>
                    current === "settings" ? null : "settings",
                  )
                }
              >
                <Icon name="settings" size={17} />
              </button>
            </aside>
            {sidebarPanel === "files" && (
              <aside className="side-panel">
                <div className="side-panel-head">Explorer</div>
                <div className="side-panel-body explorer-list">
                  {fileOrder.map((file) => (
                    <button
                      key={file}
                      className={`explorer-row ${tab === file ? "active" : ""}`}
                      onClick={() => openFile(file)}
                      title={file}
                    >
                      <i className={`file-dot ${file.split(".").pop()}`} />
                      <span className="explorer-name">{file}</span>
                      {file !== "index.html" && (
                        <span
                          className="delete-file"
                          role="button"
                          aria-label={`Delete ${file}`}
                          title="Delete file"
                          onClick={(event) => {
                            event.stopPropagation();
                            setFileToDelete(file);
                          }}
                        >
                          ×
                        </span>
                      )}
                    </button>
                  ))}
                  <button
                    className="explorer-add"
                    onClick={() => setAddingFile(true)}
                  >
                    <Icon name="plus" size={12} /> new file
                  </button>
                </div>
              </aside>
            )}
            {sidebarPanel === "search" && (
              <aside className="side-panel">
                <div className="side-panel-head">Search</div>
                <div className="side-panel-body search-panel">
                  <input
                    className="search-input"
                    placeholder="Search across files"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    aria-label="Search across files"
                  />
                  {searchQuery.trim().length < 2 ? (
                    <p className="side-panel-empty">
                      Type at least 2 characters to search{" "}
                      {fileOrder.join(", ")}.
                    </p>
                  ) : searchResults.length === 0 ? (
                    <p className="side-panel-empty">No results found.</p>
                  ) : (
                    <div className="search-results">
                      {searchResults.map((group) => (
                        <div key={group.file} className="search-file-group">
                          <div className="search-file-head">
                            <i
                              className={`file-dot ${group.file.split(".").pop()}`}
                            />
                            {group.file}
                            <span>{group.matches.length}</span>
                          </div>
                          {group.matches.map((match) => (
                            <button
                              key={match.line}
                              className="search-match"
                              onClick={() => {
                                openFile(group.file);
                                setRevealRequest({
                                  file: group.file,
                                  line: match.line,
                                });
                              }}
                            >
                              <span className="search-line-no">
                                {match.line}
                              </span>
                              {highlightMatch(match.text, searchQuery.trim())}
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </aside>
            )}
            {sidebarPanel === "changes" && (
              <aside className="side-panel">
                <div className="side-panel-head">Source Control</div>
                <div className="side-panel-body changes-panel">
                  <p className="changes-branch">
                    <Icon name="branch" size={11} /> main*
                  </p>
                  {changedFiles.length ? (
                    <ul className="changes-list">
                      {changedFiles.map((file) => (
                        <li key={file}>
                          <button onClick={() => openFile(file)} title={file}>
                            <i
                              className={`file-dot ${file.split(".").pop()}`}
                            />
                            {file}
                          </button>
                          <span className="change-badge">M</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="side-panel-empty">
                      No changes yet — start editing to see files here.
                    </p>
                  )}
                  <p className="changes-note">
                    Changes publish to your GitHub Pages repo when the match
                    ends.
                  </p>
                </div>
              </aside>
            )}
            {sidebarPanel === "settings" && (
              <aside className="side-panel">
                <div className="side-panel-head">Editor</div>
                <div className="side-panel-body settings-panel">
                  <label className="settings-row">
                    <span>Word wrap</span>
                    <button
                      className={`toggle-switch ${editorPrefs.wordWrap ? "on" : ""}`}
                      role="switch"
                      aria-checked={editorPrefs.wordWrap}
                      aria-label="Word wrap"
                      onClick={() =>
                        setEditorPrefs((prefs) => ({
                          ...prefs,
                          wordWrap: !prefs.wordWrap,
                        }))
                      }
                    >
                      <i />
                    </button>
                  </label>
                  <label className="settings-row">
                    <span>Minimap</span>
                    <button
                      className={`toggle-switch ${editorPrefs.minimap ? "on" : ""}`}
                      role="switch"
                      aria-checked={editorPrefs.minimap}
                      aria-label="Minimap"
                      onClick={() =>
                        setEditorPrefs((prefs) => ({
                          ...prefs,
                          minimap: !prefs.minimap,
                        }))
                      }
                    >
                      <i />
                    </button>
                  </label>
                  <div className="settings-row">
                    <span>Font size</span>
                    <div className="settings-stepper">
                      <button
                        aria-label="Decrease font size"
                        onClick={() =>
                          setEditorPrefs((prefs) => ({
                            ...prefs,
                            fontSize: Math.max(11, prefs.fontSize - 1),
                          }))
                        }
                      >
                        −
                      </button>
                      <b>{editorPrefs.fontSize}</b>
                      <button
                        aria-label="Increase font size"
                        onClick={() =>
                          setEditorPrefs((prefs) => ({
                            ...prefs,
                            fontSize: Math.min(22, prefs.fontSize + 1),
                          }))
                        }
                      >
                        +
                      </button>
                    </div>
                  </div>
                  <div className="settings-row">
                    <span>Tab size</span>
                    <div className="settings-segmented">
                      {[2, 4].map((size) => (
                        <button
                          key={size}
                          className={
                            editorPrefs.tabSize === size ? "active" : ""
                          }
                          onClick={() =>
                            setEditorPrefs((prefs) => ({
                              ...prefs,
                              tabSize: size,
                            }))
                          }
                        >
                          {size}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </aside>
            )}
            <CollaborativeEditor
              room={room}
              file={tab}
              initialValue={
                starterFiles[tab] ??
                FILE_TEMPLATES[
                  (tab.split(".").pop() as "html" | "css" | "js") ?? "html"
                ]
              }
              onChange={updateCurrentFile}
              onLocalEdit={(activity) => void reportHackatimeActivity(activity)}
              wordWrap={editorPrefs.wordWrap}
              minimapEnabled={editorPrefs.minimap}
              fontSize={editorPrefs.fontSize}
              tabSize={editorPrefs.tabSize}
              revealRequest={revealRequest}
            />
          </div>
          <footer className="editor-status">
            <span>main*</span>
            <span>spaces: 2</span>
            <span>utf-8</span>
            <strong className={`hackatime-recording ${hackatimeRecording}`}>
              <i /> Hackatime ·{" "}
              {hackatimeRecording === "recorded"
                ? "recording"
                : hackatimeRecording}
            </strong>
            <b>Liveblocks · {status}</b>
          </footer>
        </div>
        <aside className="preview-panel">
          <iframe
            ref={registerOwnPreviewFrame}
            title="Your website live preview"
            srcDoc={iframeSrcDoc}
            sandbox="allow-scripts"
            allow={PREVIEW_IFRAME_ALLOW}
            referrerPolicy="no-referrer"
          />
          <button
            className="preview-expand-button"
            onClick={() => setPreviewOpen(!previewOpen)}
            aria-label={
              previewOpen ? "Hide expanded preview" : "Expand preview"
            }
          >
            <Icon name="external" size={13} />
          </button>
        </aside>
        <div className="match-bottom-row">
          <div className="opponent-panel">
            {opponentSnapshot ? (
              <iframe
                title="Opponent website preview"
                srcDoc={opponentSnapshot}
                sandbox="allow-scripts"
                allow={PREVIEW_IFRAME_ALLOW}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="snapshot-art">
                <span className="planet-one" />
                <span className="planet-two" />
                <b>
                  waiting for
                  <br />
                  their first sync
                </b>
              </div>
            )}
            <button
              className="preview-expand-button"
              onClick={() => setOpponentPreviewOpen(!opponentPreviewOpen)}
              aria-label={
                opponentPreviewOpen
                  ? "Hide expanded opponent preview"
                  : "Expand opponent preview"
              }
            >
              <Icon name="external" size={13} />
            </button>
          </div>
          <div className="call-controls">
            <button
              className={mic ? "active" : ""}
              onClick={() => setMic(!mic)}
              aria-label="Toggle microphone"
            >
              <Icon name={mic ? "mic" : "mic-off"} size={16} />
              <span>mic</span>
            </button>
            <button
              className={video ? "active" : ""}
              onClick={() => setVideo(!video)}
              aria-label="Toggle camera"
            >
              <Icon name={video ? "camera" : "camera-off"} size={16} />
              <span>camera</span>
            </button>
            <div className="av-settings-anchor" ref={avSettingsAnchorRef}>
              <button
                aria-label="Audio and video settings"
                aria-expanded={avSettingsOpen}
                onClick={() => setAvSettingsOpen((open) => !open)}
              >
                <Icon name="settings" size={16} />
                <span>settings</span>
              </button>
              {avSettingsOpen && (
                <div
                  className="av-settings-menu"
                  role="dialog"
                  aria-label="Audio and video settings"
                >
                  <div className="device-row-group">
                    <label className="device-row">
                      <span>microphone input</span>
                      <select
                        aria-label="Microphone"
                        value={micDeviceId}
                        onChange={(event) => setMicDeviceId(event.target.value)}
                      >
                        <option value="">Default</option>
                        {devices
                          .filter((device) => device.kind === "audioinput")
                          .map((device, index) => (
                            <option
                              key={device.deviceId}
                              value={device.deviceId}
                            >
                              {device.label || `Microphone ${index + 1}`}
                            </option>
                          ))}
                      </select>
                    </label>
                    <label className="device-row">
                      <span>camera</span>
                      <select
                        aria-label="Camera"
                        value={videoDeviceId}
                        onChange={(event) =>
                          setVideoDeviceId(event.target.value)
                        }
                      >
                        <option value="">Default</option>
                        {devices
                          .filter((device) => device.kind === "videoinput")
                          .map((device, index) => (
                            <option
                              key={device.deviceId}
                              value={device.deviceId}
                            >
                              {device.label || `Camera ${index + 1}`}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                </div>
              )}
            </div>
            {match.mode === "duo" && (
              <div className="scope-toggle">
                <button
                  className={scope === "team" ? "active" : ""}
                  onClick={() => setScope("team")}
                >
                  duo only
                </button>
                <button
                  className={scope === "everyone" ? "active" : ""}
                  onClick={() => setScope("everyone")}
                >
                  everyone
                </button>
              </div>
            )}
          </div>
        </div>
      </section>
      {previewOpen && (
        <div
          className="preview-modal modal-backdrop"
          onClick={() => setPreviewOpen(false)}
        >
          <div
            className="expanded-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setPreviewOpen(false)}>×</button>
            <iframe
              ref={registerOwnPreviewFrame}
              title="Expanded live preview"
              srcDoc={iframeSrcDoc}
              sandbox="allow-scripts"
              allow={PREVIEW_IFRAME_ALLOW}
              referrerPolicy="no-referrer"
            />
          </div>
        </div>
      )}
      {opponentPreviewOpen && (
        <div
          className="preview-modal modal-backdrop"
          onClick={() => setOpponentPreviewOpen(false)}
        >
          <div
            className="expanded-preview"
            onClick={(e) => e.stopPropagation()}
          >
            <button onClick={() => setOpponentPreviewOpen(false)}>×</button>
            {opponentSnapshot ? (
              <iframe
                title="Expanded opponent preview"
                srcDoc={opponentSnapshot}
                sandbox="allow-scripts"
                allow={PREVIEW_IFRAME_ALLOW}
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="snapshot-art">
                <span className="planet-one" />
                <span className="planet-two" />
                <b>
                  waiting for
                  <br />
                  their first sync
                </b>
              </div>
            )}
          </div>
        </div>
      )}
      {descriptionOpen && !outcome && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="description-title"
        >
          <section className="modal publish-modal">
            <h2 id="description-title">describe your site!</h2>
            <p>
              two sentences about what your website is, what it does, and how it
              works!
            </p>
            <label className="description-field">
              <textarea
                value={description}
                onChange={(event) => {
                  setDescription(
                    event.target.value.slice(0, DESCRIPTION_MAX_LENGTH),
                  );
                  if (descriptionError) setDescriptionError(null);
                }}
                placeholder="a website where you click through the different options to get through the maze and escape the monster, but if you don't answer the questions fast enough you get eaten."
                maxLength={DESCRIPTION_MAX_LENGTH}
                autoFocus
                rows={4}
              />
              <span className="description-count">
                {description.length}/{DESCRIPTION_MAX_LENGTH}
              </span>
            </label>
            {descriptionError && (
              <p className="publish-error">{descriptionError}</p>
            )}
            <button className="primary-button" onClick={submitDescription}>
              continue
            </button>
          </section>
        </div>
      )}
      {resultsOpen && !outcome && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="results-title"
        >
          <section className="modal results-modal">
            <h2 id="results-title">{match.theme}</h2>
            <div className="vote-grid results-grid">
              <article>
                <div className="vote-site">
                  <iframe
                    ref={registerOwnPreviewFrame}
                    title="Your site"
                    srcDoc={iframeSrcDoc}
                    sandbox="allow-scripts"
                    allow={PREVIEW_IFRAME_ALLOW}
                    referrerPolicy="no-referrer"
                  />
                  <button
                    className="preview-expand-button"
                    onClick={() => setPreviewOpen(true)}
                    aria-label="View your site full screen"
                  >
                    <Icon name="external" size={13} />
                  </button>
                </div>
                <footer>
                  <span>YOUR SITE</span>
                </footer>
              </article>
              <div className="versus">VS</div>
              <article>
                <div className="vote-site">
                  {opponentSnapshot ? (
                    <iframe
                      title="Opponent's site"
                      srcDoc={opponentSnapshot}
                      sandbox="allow-scripts"
                      allow={PREVIEW_IFRAME_ALLOW}
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="snapshot-art">
                      <span className="planet-one" />
                      <span className="planet-two" />
                      <b>no snapshot synced yet</b>
                    </div>
                  )}
                  {opponentSnapshot && (
                    <button
                      className="preview-expand-button"
                      onClick={() => setOpponentPreviewOpen(true)}
                      aria-label="View opponent's site full screen"
                    >
                      <Icon name="external" size={13} />
                    </button>
                  )}
                </div>
                <footer>
                  <span>OPPONENT&apos;S SITE</span>
                </footer>
              </article>
            </div>
            <button
              className="primary-button"
              onClick={() => {
                setResultsOpen(false);
                setPublishOpen(true);
              }}
            >
              publish to GitHub <Icon name="external" size={13} />
            </button>
          </section>
        </div>
      )}
      {(publishOpen || publishState.repositoryUrl) && !outcome && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="publish-title"
        >
          <section className="modal publish-modal">
            <iframe
              ref={submissionCaptureRef}
              className="submission-capture-frame"
              title="Automatic submission screenshot"
              srcDoc={previewDoc}
              sandbox="allow-same-origin"
              allow={PREVIEW_IFRAME_ALLOW}
              tabIndex={-1}
              aria-hidden="true"
            />
            <h2 id="publish-title">
              {publishState.repositoryUrl
                ? "Your build is open source."
                : "Name this build."}
            </h2>
            {publishState.repositoryUrl ? (
              <>
                <p>
                  Every player publishes the finished build to their own
                  account. Voting opens after everyone has finished publishing.
                </p>
                <div className="publish-links">
                  <a
                    href={publishState.repositoryUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    view source <Icon name="external" size={11} />
                  </a>
                  {pagesReady || pagesStalled ? (
                    <a
                      href={publishState.pagesUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open live website <Icon name="external" size={11} />
                    </a>
                  ) : (
                    <span className="pending" aria-live="polite">
                      <i />
                      deploying
                      {pagesCountdown > 0 ? ` · ~${pagesCountdown}s` : "…"}
                    </span>
                  )}
                </div>
                <button
                  className="primary-button"
                  onClick={() => navigate("home")}
                >
                  return home
                </button>
              </>
            ) : (
              <>
                <p>
                  Every build lands as its own folder inside{" "}
                  <strong>hackclubranked</strong>, the one repo on{" "}
                  {auth.github ? (
                    <strong>@{auth.github.login}</strong>
                  ) : (
                    "your GitHub account"
                  )}{" "}
                  that collects all your Ranked builds.
                </p>
                <label className="repo-name-field">
                  <span title={`${auth.github?.login ?? "you"}/hackclubranked/`}>
                    {auth.github?.login ?? "you"}/hackclubranked/
                  </span>
                  <input
                    value={buildName}
                    onChange={(event) => {
                      setBuildName(event.target.value);
                      if (publishState.error)
                        setPublishState({ loading: false });
                    }}
                    placeholder="my-ranked-build"
                    autoFocus
                    maxLength={100}
                    pattern="[A-Za-z0-9._\-]+"
                    required
                  />
                </label>
                {submissionProfile.loading ? (
                  <p className="hca-address-note">
                    loading your HCA profile…
                  </p>
                ) : submissionProfile.ready ? (
                  <p className="hca-address-note">
                    Ships to your primary address on{" "}
                    <a
                      href="https://auth.hackclub.com"
                      target="_blank"
                      rel="noreferrer"
                    >
                      auth.hackclub.com
                    </a>
                    .
                  </p>
                ) : (
                  <div className="hca-address-missing">
                    <p>
                      Reconnect Hack Club Auth to share your verified birthday
                      and choose an address for the automatic submission.
                    </p>
                    <a
                      className="github-connect"
                      href="/api/auth/hackclub/start"
                    >
                      reconnect Hack Club Auth
                    </a>
                  </div>
                )}
                {publishState.error && (
                  <p className="publish-error">{publishState.error}</p>
                )}
                {auth.github ? (
                  <button
                    className="primary-button"
                    onClick={() => void publish()}
                    disabled={
                      publishState.loading ||
                      !buildName ||
                      submissionProfile.loading ||
                      !submissionProfile.ready
                    }
                  >
                    {publishState.loading ? (
                      "publishing…"
                    ) : (
                      <>
                        publish to hackclubranked{" "}
                        <Icon name="external" size={13} />
                      </>
                    )}
                  </button>
                ) : (
                  <a
                    className="primary-button github-connect"
                    href="/api/auth/github/start"
                  >
                    <Icon name="github" size={15} /> connect GitHub
                  </a>
                )}
                <small>
                  Includes the finished site plus the original HTML, CSS, and
                  JavaScript files.
                </small>
                {canSkipPublish && (
                  <button
                    className="skip-publish-button"
                    onClick={() => void forfeit()}
                    disabled={forfeitLoading}
                  >
                    {forfeitLoading
                      ? "closing…"
                      : "skip — end test match without publishing"}
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      )}
      {forfeitOpen && !outcome && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="forfeit-title"
        >
          <section className="modal publish-modal forfeit-modal">
            <h2 id="forfeit-title">Forfeit the match?</h2>
            <p>
              This ends the match immediately. The other team wins and ELO is
              updated.
            </p>
            <div className="forfeit-actions">
              <button
                onClick={() => setForfeitOpen(false)}
                disabled={forfeitLoading}
              >
                keep coding
              </button>
              <button
                className="danger-button"
                onClick={() => void forfeit()}
                disabled={forfeitLoading}
              >
                {forfeitLoading ? "closing match…" : "yes, forfeit"}
              </button>
            </div>
          </section>
        </div>
      )}
      {outcome && (
        <div
          className="modal-backdrop"
          role="dialog"
          aria-modal="true"
          aria-labelledby="outcome-title"
        >
          <section className="modal publish-modal outcome-modal">
            <h2 id="outcome-title">
              {isTestMatch
                ? "Test match ended."
                : outcome.winningTeam === team
                  ? "You win by forfeit."
                  : "Your team forfeited."}
            </h2>
            <p>
              {isTestMatch ? (
                "No ELO changes, nothing published. Start another empty lobby anytime."
              ) : (
                <>
                  {outcome.endReason === "disconnect"
                    ? "A player did not reconnect during the 10-second grace period."
                    : "A player chose to end the match early."}{" "}
                  ELO has been updated for both teams.
                </>
              )}
            </p>
            <button className="primary-button" onClick={() => navigate("home")}>
              return home
            </button>
          </section>
        </div>
      )}
    </main>
  );
}

type LeaderboardPage = {
  page: number;
  pageSize: number;
  totalPlayers: number;
  totalPages: number;
  yourRank: number | null;
  yourPage: number | null;
  players: Array<{
    id: string;
    name: string;
    avatar: AvatarConfig | null;
    score: number | string;
    matchesPlayed: number;
  }>;
};

function Leaderboard({
  navigate,
  auth,
}: {
  navigate: (s: Screen) => void;
  auth: AuthState;
}) {
  const [board, setBoard] = useState<"elo" | "hours">("hours");
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const [data, setData] = useState<LeaderboardPage | null>(null);
  const profileCard = useProfileHoverCard();

  const changeBoard = (next: "hours" | "elo") => {
    setBoard(next);
    setRequestedPage(null);
    setData(null);
  };

  useEffect(() => {
    const params = new URLSearchParams({ type: board });
    if (requestedPage) params.set("page", String(requestedPage));
    fetch(`/api/leaderboard?${params}`)
      .then((response) => response.json())
      .then((result) => setData(result))
      .catch(() => setData(null));
  }, [board, requestedPage]);

  const onYourPage = Boolean(data?.yourPage && data.yourPage === data.page);

  return (
    <main className="subpage screen-pad">
      <button className="lobby-exit-button" onClick={() => navigate("home")}>
        <Icon name="arrow-left" size={14} />
        back to dash
      </button>
      <div className="subpage-head">
        <h1>Leaderboard</h1>
      </div>
      <div className="board-toggle">
        <button
          className={board === "hours" ? "active" : ""}
          onClick={() => changeBoard("hours")}
        >
          hours
        </button>
        <button
          className={board === "elo" ? "active" : ""}
          onClick={() => changeBoard("elo")}
        >
          elo
        </button>
      </div>
      <section className="leader-card">
        <div className="leader-row leader-head">
          <span>rank</span>
          <span>name</span>
          <span>{board === "elo" ? "ELO" : "hours"}</span>
          <span>matches played</span>
        </div>
        {data?.players.map((row, index) => {
          const rank = (data.page - 1) * data.pageSize + index + 1;
          const isYou = row.id === auth.user?.id;
          return (
            <div
              className={isYou ? "leader-row you" : "leader-row"}
              key={row.id}
            >
              <strong>#{rank}</strong>
              <span>
                <button
                  type="button"
                  className="person-face-button"
                  {...profileCard.triggerProps(row.id)}
                  aria-label={`View ${row.name}'s profile`}
                >
                  <PersonFace name={row.name} avatar={row.avatar} />
                </button>
                <b>{row.name}</b>
                {isYou && <em className="leader-you-tag">you</em>}
              </span>
              <strong>{row.score}</strong>
              <span>{row.matchesPlayed}</span>
            </div>
          );
        })}
      </section>
      {data && data.totalPages > 1 && (
        <div className="leader-pagination">
          <button
            className="lobby-exit-button"
            disabled={data.page <= 1}
            onClick={() => setRequestedPage(data.page - 1)}
          >
            <Icon name="arrow-left" size={13} />
          </button>
          <span>
            page {data.page} of {data.totalPages}
          </span>
          <button
            className="lobby-exit-button"
            disabled={data.page >= data.totalPages}
            onClick={() => setRequestedPage(data.page + 1)}
          >
            <Icon name="arrow-left" size={13} className="icon-flip" />
          </button>
          {data.yourPage && !onYourPage && (
            <button
              className="leader-jump-button"
              onClick={() => setRequestedPage(data.yourPage)}
            >
              jump to my rank (#{data.yourRank})
            </button>
          )}
        </div>
      )}
      {profileCard.openProfileId && profileCard.anchor && (
        <PlayerProfileCard
          userId={profileCard.openProfileId}
          anchor={profileCard.anchor}
          onMouseEnter={profileCard.cancelClose}
          onMouseLeave={profileCard.scheduleClose}
        />
      )}
    </main>
  );
}

const AUDIT_CATEGORY_LABELS: Record<string, string> = {
  auth: "login",
  admin: "admin",
  match: "match",
  report: "report",
  shop: "shop",
  vote: "vote",
};

type AuditEntry = {
  id: string;
  createdAt: string;
  action: string;
  summary: string;
  actorName: string | null;
  actorEmail: string | null;
};

type AuditPage = {
  page: number;
  totalEntries: number;
  totalPages: number;
  entries: AuditEntry[];
};

function AdminAuditLog({ navigate }: { navigate: (s: Screen) => void }) {
  const [queryInput, setQueryInput] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [query, setQuery] = useState("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [requestedPage, setRequestedPage] = useState<number | null>(null);
  const [data, setData] = useState<AuditPage | null>(null);
  const hasFilters = Boolean(query || fromDate || toDate);

  // Typing a date fires onChange per keystroke (each digit of the day/month/
  // year segments), same as the search box — debounce all three so a filter
  // only actually commits once the admin pauses, instead of every partial
  // (often invalid, momentarily unfiltered) value firing its own request.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [queryInput]);
  useEffect(() => {
    const timer = window.setTimeout(() => setFromDate(fromInput), 300);
    return () => window.clearTimeout(timer);
  }, [fromInput]);
  useEffect(() => {
    const timer = window.setTimeout(() => setToDate(toInput), 300);
    return () => window.clearTimeout(timer);
  }, [toInput]);

  // Any filter change re-starts the browse from page 1 — staying on, say,
  // page 6 of an unfiltered feed would otherwise land past the end of a
  // narrower filtered result set.
  useEffect(() => {
    const resetPage = window.setTimeout(() => setRequestedPage(null), 0);
    return () => window.clearTimeout(resetPage);
  }, [query, fromDate, toDate]);

  // Debouncing narrows the race but doesn't close it — two requests can still
  // be in flight together, and network ordering doesn't guarantee the newer
  // one resolves last. Tag each request and drop any response that isn't
  // from the most recently issued one, so a slow stale request can never
  // clobber a newer result.
  const latestRequestRef = useRef(0);
  useEffect(() => {
    const requestId = ++latestRequestRef.current;
    const params = new URLSearchParams();
    if (requestedPage) params.set("page", String(requestedPage));
    if (query) params.set("q", query);
    if (fromDate) params.set("from", fromDate);
    if (toDate) params.set("to", toDate);
    fetch(`/api/admin/audit-log?${params}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (latestRequestRef.current === requestId) setData(result);
      })
      .catch(() => {
        if (latestRequestRef.current === requestId) setData(null);
      });
  }, [requestedPage, query, fromDate, toDate]);

  return (
    <main className="subpage screen-pad">
      <button className="lobby-exit-button" onClick={() => navigate("home")}>
        <Icon name="arrow-left" size={14} />
        back to dash
      </button>
      <div className="subpage-head">
        <h1>Audit Log</h1>
      </div>
      <div className="audit-filters">
        <div className="audit-search">
          <Icon name="search" size={12} />
          <input
            type="text"
            value={queryInput}
            onChange={(event) => setQueryInput(event.target.value)}
            placeholder="search users, events, keywords"
            aria-label="Search audit log"
          />
        </div>
        <div className="audit-date-range">
          <label>
            <span>from</span>
            <input
              type="date"
              value={fromInput}
              max={toInput || undefined}
              onChange={(event) => setFromInput(event.target.value)}
              aria-label="From date"
            />
          </label>
          <label>
            <span>to</span>
            <input
              type="date"
              value={toInput}
              min={fromInput || undefined}
              onChange={(event) => setToInput(event.target.value)}
              aria-label="To date"
            />
          </label>
          {hasFilters && (
            <button
              type="button"
              className="audit-clear-filters"
              onClick={() => {
                setQueryInput("");
                setQuery("");
                setFromInput("");
                setFromDate("");
                setToInput("");
                setToDate("");
              }}
            >
              clear
            </button>
          )}
        </div>
      </div>
      <section className="audit-card">
        {data && data.entries.length === 0 && (
          <p className="audit-empty">
            {hasFilters
              ? "No events match those filters."
              : "Nothing logged yet."}
          </p>
        )}
        {data?.entries.map((entry) => {
          const category = entry.action.split(".")[0];
          const label = AUDIT_CATEGORY_LABELS[category] ?? category;
          return (
            <div className="audit-row" key={entry.id}>
              <span
                className={`audit-tag audit-tag-${AUDIT_CATEGORY_LABELS[category] ? category : "default"}`}
              >
                {label}
              </span>
              <div className="audit-body">
                <p>{entry.summary}</p>
                <span className="audit-meta">
                  {new Date(entry.createdAt).toLocaleString()}
                  {entry.actorName && ` · ${entry.actorName}`}
                </span>
              </div>
            </div>
          );
        })}
      </section>
      {data && data.totalPages > 1 && (
        <div className="admin-pagination">
          <button
            className="lobby-exit-button"
            disabled={data.page <= 1}
            onClick={() => setRequestedPage(data.page - 1)}
          >
            <Icon name="arrow-left" size={13} />
          </button>
          <span>
            page {data.page} of {data.totalPages} · {data.totalEntries} events
          </span>
          <button
            className="lobby-exit-button"
            disabled={data.page >= data.totalPages}
            onClick={() => setRequestedPage(data.page + 1)}
          >
            <Icon name="arrow-left" size={13} className="icon-flip" />
          </button>
        </div>
      )}
    </main>
  );
}

function Shop({
  navigate,
  toast,
  auth,
  avatarInventory,
  onAvatarPurchased,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  avatarInventory: Set<string>;
  onAvatarPurchased: () => void;
}) {
  const [selected, setSelected] = useState<ShopItem | null>(null);
  useEscapeKey(Boolean(selected), () => setSelected(null));
  const [balance, setBalance] = useState(auth.user?.hBucks ?? 0);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  useEffect(() => {
    if (auth.user)
      fetch("/api/shop/orders")
        .then((r) => r.json())
        .then((data) => setBalance(data.balance ?? 0))
        .catch(() => undefined);
  }, [auth.user]);

  const redeemItem = async (
    itemId: string,
    shipping?: Record<string, string>,
  ) => {
    const response = await fetch("/api/shop/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId, shipping }),
    });
    const result = await response.json();
    if (!response.ok) {
      toast(result.error ?? "Redemption failed");
      return false;
    }
    setBalance(result.balance);
    return true;
  };

  const redeemPhysical = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const shipping = Object.fromEntries(form.entries()) as Record<
      string,
      string
    >;
    if (await redeemItem(selected.id, shipping)) {
      setSelected(null);
      toast("Redemption submitted for approval");
    }
  };

  const redeemAvatarItem = async (item: AvatarShopItem) => {
    if (redeemingId) return;
    setRedeemingId(item.id);
    try {
      if (await redeemItem(item.id)) {
        toast(`Unlocked "${item.name}", equip it in the wardrobe`);
        onAvatarPurchased();
      }
    } finally {
      setRedeemingId(null);
    }
  };

  return (
    <main className="subpage shop-page screen-pad">
      <button className="lobby-exit-button" onClick={() => navigate("home")}>
        <Icon name="arrow-left" size={14} />
        back to dash
      </button>
      <div className="subpage-head">
        <div className="balance">
          you have <strong>{balance} Ħ</strong>
        </div>
      </div>
      <section className="product-grid">
        {SHOP_CATALOG.map((item) => {
          const owned = item.kind === "avatar" && avatarInventory.has(item.id);
          return (
            <article
              key={item.id}
              className="product-card"
              style={{ "--product": item.color } as React.CSSProperties}
            >
              <div className="product-art">
                {item.kind === "physical" ? (
                  <Icon name={item.iconName as IconName} size={56} />
                ) : (
                  <ScribbleAvatar
                    avatar={{ ...DEFAULT_AVATAR, [item.part]: item.value }}
                    size="sm"
                  />
                )}
              </div>
              <h2>{item.name}</h2>
              <p>{item.description}</p>
              <div>
                <strong>{item.cost.toLocaleString()} Ħ</strong>
                {owned ? (
                  <span className="product-owned">owned</span>
                ) : (
                  <button
                    disabled={item.kind === "avatar" && redeemingId === item.id}
                    onClick={() => {
                      if (item.cost > balance)
                        return toast(
                          `Keep building, you need more H-Bucks for ${item.name}`,
                        );
                      if (item.kind === "avatar") void redeemAvatarItem(item);
                      else setSelected(item);
                    }}
                  >
                    {item.kind === "avatar" && redeemingId === item.id
                      ? "unlocking…"
                      : "redeem"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </section>
      {selected && selected.kind === "physical" && (
        <div className="modal-backdrop">
          <form
            className="modal shipping-modal"
            onSubmit={(event) => void redeemPhysical(event)}
          >
            <button
              type="button"
              className="close-button"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <h2>Ship your {selected.name}</h2>
            <input name="name" placeholder="Full name" required />
            <input name="address1" placeholder="Address" required />
            <input name="address2" placeholder="Apartment / suite" />
            <input name="city" placeholder="City" required />
            <input name="region" placeholder="State / region" required />
            <input name="postalCode" placeholder="Postal code" required />
            <input name="country" placeholder="Country" required />
            <button className="primary-button" type="submit">
              redeem {selected.cost.toLocaleString()} Ħ
            </button>
          </form>
        </div>
      )}
    </main>
  );
}

function Wardrobe({
  navigate,
  toast,
  auth,
  avatarInventory,
  onAvatarUpdated,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  avatarInventory: Set<string>;
  onAvatarUpdated: (avatar: ResolvedAvatarConfig) => void;
}) {
  const [draft, setDraft] = useState<ResolvedAvatarConfig>(() =>
    normalizeAvatar(auth.user?.avatar),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const save = async () => {
    if (!auth.user || saving) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ avatar: draft }),
      });
      const result = (await response.json()) as {
        user?: { avatar: AvatarConfig };
        error?: string;
      };
      if (!response.ok)
        throw new Error(result.error ?? "Could not save your Scrib.");
      onAvatarUpdated(normalizeAvatar(result.user!.avatar));
      toast("Wardrobe updated");
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "Could not save your Scrib. Try again.",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="subpage wardrobe-page screen-pad">
      <button className="lobby-exit-button" onClick={() => navigate("home")}>
        <Icon name="arrow-left" size={14} />
        back to dash
      </button>
      <div className="subpage-head">
        <h1>Wardrobe</h1>
      </div>
      <AvatarCustomizer
        value={draft}
        onChange={setDraft}
        ownedPremiumIds={avatarInventory}
      />
      <div className="wardrobe-actions">
        <button
          className="primary-button"
          onClick={() => void save()}
          disabled={saving}
        >
          {saving ? "saving…" : "save Scrib"}
        </button>
        <button
          type="button"
          className="wardrobe-shop-link"
          onClick={() => navigate("shop")}
        >
          browse more looks in the shop <Icon name="external" size={11} />
        </button>
      </div>
      {error && <p className="avatar-save-error">{error}</p>}
    </main>
  );
}

function BuildDescription({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [clamped, setClamped] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Descriptions run up to 500 characters but the card only has room for
    // three lines — measuring the real clamp (scrollHeight vs clientHeight)
    // instead of guessing off character count means the toggle only shows up
    // when text is actually being cut off.
    setClamped(el.scrollHeight > el.clientHeight + 1);
  }, [text]);
  return (
    <div className="build-description-wrap">
      <p
        ref={ref}
        className={`build-description${expanded ? " expanded" : ""}`}
      >
        {text}
      </p>
      {clamped && (
        <button
          type="button"
          className="build-description-toggle"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "show less" : "read more"}
        </button>
      )}
    </div>
  );
}

function Voting({
  navigate,
  toast,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
}) {
  const [voted, setVoted] = useState<"blue" | "red" | null>(null);
  const [match, setMatch] = useState<{
    id: string;
    theme: string;
    durationMinutes: number;
    sites: Record<
      "blue" | "red",
      { pagesUrl: string; repositoryUrl: string; description: string | null }
    >;
  } | null>(null);
  const [voteGate, setVoteGate] = useState<{
    required: number;
    cast: number;
  } | null>(null);
  const [pendingNext, setPendingNext] = useState<{
    match: typeof match;
    voteGate: typeof voteGate;
  } | null>(null);

  const [everVoted, setEverVoted] = useState(false);

  const loadNext = useCallback(() => {
    return fetch("/api/votes")
      .then((r) => r.json())
      .then((data) => {
        setMatch(data.match ?? null);
        setVoteGate(data.voteGate ?? null);
        setVoted(null);
        setPendingNext(null);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    void loadNext();
  }, [loadNext]);

  const remaining = voteGate
    ? Math.max(0, voteGate.required - voteGate.cast)
    : 0;
  const stillOwed = Boolean(voteGate && voteGate.required > 0 && remaining > 0);

  useEffect(() => {
    if (!match && stillOwed && !everVoted) navigate("lobby");
  }, [match, stillOwed, everVoted, navigate]);

  const vote = async (choice: "blue" | "red") => {
    if (!match) return;
    const response = await fetch("/api/votes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId: match.id, choice }),
    });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Vote failed");
    setVoted(choice);
    setEverVoted(true);
    toast("Vote counted");
    const next = await fetch("/api/votes")
      .then((r) => r.json())
      .catch(() => null);
    setPendingNext(
      next
        ? { match: next.match ?? null, voteGate: next.voteGate ?? null }
        : null,
    );
  };
  const continueVoting = () => {
    if (pendingNext?.match) {
      setMatch(pendingNext.match);
      setVoteGate(pendingNext.voteGate);
      setVoted(null);
      setPendingNext(null);
    } else {
      setVoteGate(pendingNext?.voteGate ?? voteGate);
      setMatch(null);
      setVoted(null);
      setPendingNext(null);
    }
  };
  return (
    <main className="vote-page screen-pad">
      <button className="lobby-exit-button" onClick={() => navigate("home")}>
        <Icon name="arrow-left" size={14} />
        back to dash
      </button>
      <div className="vote-heading">
        <h1>
          {match
            ? "Which site fits the theme best?"
            : "No matches in voting queue"}
        </h1>
        {(match || (voteGate && voteGate.required > 0)) && (
          <p>
            {match ? `theme: ${match.theme}` : ""}
            {match && voteGate && voteGate.required > 0 ? " · " : ""}
            {voteGate && voteGate.required > 0
              ? `${Math.min(voteGate.cast, voteGate.required)}/${voteGate.required} voted`
              : ""}
          </p>
        )}
      </div>
      {match && (
        <>
          <section className="vote-grid">
            <article className={voted === "blue" ? "chosen" : ""}>
              <div className="vote-site">
                <iframe
                  title="Build A"
                  src={match.sites.blue.pagesUrl}
                  sandbox="allow-scripts allow-same-origin"
                  allow={PREVIEW_IFRAME_ALLOW}
                  referrerPolicy="no-referrer"
                />
              </div>
              {match.sites.blue.description && (
                <BuildDescription text={match.sites.blue.description} />
              )}
              <footer>
                <div>
                  <span>BUILD A</span>
                  <small>
                    anonymous · {match.durationMinutes} min ·{" "}
                    <a
                      href={match.sites.blue.repositoryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      source <Icon name="external" size={10} />
                    </a>
                  </small>
                </div>
                <button onClick={() => void vote("blue")}>
                  {voted === "blue" ? (
                    <>
                      your vote <Icon name="check" size={11} />
                    </>
                  ) : (
                    "vote for this"
                  )}
                </button>
              </footer>
            </article>
            <div className="versus">VS</div>
            <article className={voted === "red" ? "chosen" : ""}>
              <div className="vote-site">
                <iframe
                  title="Build B"
                  src={match.sites.red.pagesUrl}
                  sandbox="allow-scripts allow-same-origin"
                  allow={PREVIEW_IFRAME_ALLOW}
                  referrerPolicy="no-referrer"
                />
              </div>
              {match.sites.red.description && (
                <BuildDescription text={match.sites.red.description} />
              )}
              <footer>
                <div>
                  <span>BUILD B</span>
                  <small>
                    anonymous · {match.durationMinutes} min ·{" "}
                    <a
                      href={match.sites.red.repositoryUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      source <Icon name="external" size={10} />
                    </a>
                  </small>
                </div>
                <button onClick={() => void vote("red")}>
                  {voted === "red" ? (
                    <>
                      your vote <Icon name="check" size={11} />
                    </>
                  ) : (
                    "vote for this"
                  )}
                </button>
              </footer>
            </article>
          </section>
          {voted && (
            <div className="vote-thanks">
              <strong>nice pick.</strong>
              <button onClick={continueVoting}>
                {pendingNext?.match ? (
                  <>
                    next matchup{" "}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                    >
                      <path
                        fill="currentColor"
                        d="M16.175 13H5q-.425 0-.712-.288T4 12t.288-.712T5 11h11.175l-4.9-4.9q-.3-.3-.288-.7t.313-.7q.3-.275.7-.288t.7.288l6.6 6.6q.15.15.213.325t.062.375t-.062.375t-.213.325l-6.6 6.6q-.275.275-.687.275T11.3 19.3q-.3-.3-.3-.712t.3-.713z"
                      />
                    </svg>
                  </>
                ) : (
                  <>
                    All done with voting! Play another match {" "}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                    >
                      <path
                        fill="currentColor"
                        d="M16.175 13H5q-.425 0-.712-.288T4 12t.288-.712T5 11h11.175l-4.9-4.9q-.3-.3-.288-.7t.313-.7q.3-.275.7-.288t.7.288l6.6 6.6q.15.15.213.325t.062.375t-.062.375t-.213.325l-6.6 6.6q-.275.275-.687.275T11.3 19.3q-.3-.3-.3-.712t.3-.713z"
                      />
                    </svg>
                  </>
                )}
              </button>
            </div>
          )}
        </>
      )}
      {!match && (
        <div className="vote-caught-up-action">
          <button className="primary-button" onClick={() => navigate("lobby")}>
            play another <Icon name="external" size={16} />
          </button>
        </div>
      )}
    </main>
  );
}

function ProfileModal({
  close,
  navigate,
  toast,
  auth,
  wardrobeUnlocked,
  logout,
  logoutLoading,
}: {
  close: () => void;
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  wardrobeUnlocked: boolean;
  logout: () => void;
  logoutLoading: boolean;
}) {
  useEscapeKey(true, close);

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="profile-title"
    >
      <section className="modal profile-modal">
        <button className="close-button" onClick={close}>
          ×
        </button>
        <ScribbleAvatar avatar={auth.user?.avatar} size="md" />
        <div>
          <h2 id="profile-title">{auth.user?.name ?? "Guest player"}</h2>
          <p>
            {auth.user
              ? `${auth.user.email} · ${auth.user.elo} ELO · ${Math.round(auth.user.codingSeconds / 360) / 10}h`
              : "Sign in to join matches"}
          </p>
          {auth.user && (
            <button
              type="button"
              className="avatar-edit-button"
              onClick={() => {
                close();
                if (wardrobeUnlocked) navigate("wardrobe");
                else
                  toast(
                    "Buy your first avatar item in the Shop to unlock the Wardrobe",
                  );
              }}
            >
              visit wardrobe
            </button>
          )}
        </div>
        <div className="account-links">
          <a href="/api/auth/hackclub/start">
            <Icon name="flag" size={14} /> Hack Club Auth{" "}
            <span>
              {auth.user ? (
                `connected${auth.user.slackId ? ` · ${auth.user.slackId}` : ""}`
              ) : (
                <>
                  connect <Icon name="external" size={10} />
                </>
              )}
            </span>
          </a>
          <a href="/api/auth/github/start">
            <Icon name="github" size={14} /> GitHub{" "}
            <span>
              {auth.github ? (
                `@${auth.github.login}`
              ) : (
                <>
                  connect <Icon name="external" size={10} />
                </>
              )}
            </span>
          </a>
          <a href="/api/auth/hackatime/start">
            <Icon name="clock" size={14} /> Hackatime{" "}
            <span>
              {auth.hackatime ? (
                `connected${auth.hackatime.email ? ` · ${auth.hackatime.email}` : ""}`
              ) : (
                <>
                  connect <Icon name="external" size={10} />
                </>
              )}
            </span>
          </a>
        </div>
        <small>
          Completed builds are published open source to GitHub and deployed to
          GitHub Pages.
        </small>
        {auth.user && (
          <div className="logout-form">
            <button type="button" onClick={logout} disabled={logoutLoading}>
              {logoutLoading
                ? "clearing site data…"
                : "log out & clear site data"}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function RankedApp() {
  const [screen, setScreen] = useState<Screen>("home");
  const [toastMessage, setToastMessage] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [avatarInventory, setAvatarInventory] = useState<Set<string>>(
    new Set(),
  );
  const [auth, setAuth] = useState<AuthState>({
    user: null,
    github: null,
    hackatime: null,
  });
  const [activeMatch, setActiveMatch] = useState<ActiveMatch | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [preAuthOpen, setPreAuthOpen] = useState(false);
  const [preAuthStep, setPreAuthStep] = useState<"avatar" | "hackclub">(
    "avatar",
  );
  // Randomized per visit (not persisted until they actually save) so a new
  // visitor's very first look at the avatar picker isn't the same scribble
  // every single time — matches the random starter avatar new accounts get
  // server-side (see the Hack Club OAuth callback) if they skip customizing.
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>(() =>
    randomStarterAvatar(),
  );
  const [mediaPrefs, setMediaPrefs] = useState<MediaPrefs>({
    mic: true,
    video: true,
  });
  const [logoutLoading, setLogoutLoading] = useState(false);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 2600);
  }, []);

  const refreshAvatarInventory = useCallback(() => {
    fetch("/api/shop/orders")
      .then((response) => response.json())
      .then((data: { orders?: Array<{ itemId: string }> }) => {
        const avatarItemIds = new Set(
          SHOP_CATALOG.filter((item) => item.kind === "avatar").map(
            (item) => item.id,
          ),
        );
        setAvatarInventory(
          new Set(
            (data.orders ?? [])
              .map((order) => order.itemId)
              .filter((id) => avatarItemIds.has(id)),
          ),
        );
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then((response) => response.json())
      .then(async (next: AuthState) => {
        const pendingAvatarRaw = next.user
          ? window.localStorage.getItem(PENDING_AVATAR_KEY)
          : null;
        if (pendingAvatarRaw) {
          window.localStorage.removeItem(PENDING_AVATAR_KEY);
          try {
            const pendingAvatar = normalizeAvatar(
              JSON.parse(pendingAvatarRaw) as AvatarConfig,
            );
            const response = await fetch("/api/profile", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ avatar: pendingAvatar }),
            });
            if (response.ok) {
              const result = (await response.json()) as {
                user: { avatar: AvatarDraft };
              };
              if (next.user) next.user.avatar = result.user.avatar;
            }
          } catch {}
          setPreAuthOpen(false);
          setPreAuthStep("avatar");
        }
        setAuth(next);
        setOnboardingOpen(
          Boolean(
            next.user &&
            (!next.github || !next.hackatime || !next.user.experience),
          ),
        );
        if (next.user) {
          refreshAvatarInventory();
          const queue = await fetch("/api/matchmaking/queue")
            .then((response) => response.json())
            .catch(() => null);
          if (queue?.match) {
            setActiveMatch(queue.match);
            setScreen("match");
          }
        }
      })
      .catch(() => setAuth({ user: null, github: null, hackatime: null }));
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "connected")
      window.setTimeout(() => toast("Hack Club account connected"), 0);
    if (params.get("github") === "connected")
      window.setTimeout(
        () => toast("GitHub connected, publishing is ready"),
        0,
      );
    if (params.get("hackatime") === "connected")
      window.setTimeout(
        () => toast("Hackatime connected — matchmaking unlocked"),
        0,
      );
    if (params.get("hackatime") === "identity_mismatch")
      window.setTimeout(
        () =>
          toast(
            "That Hackatime account does not match your Hack Club identity",
          ),
        0,
      );
    if (
      params.get("auth") === "failed" ||
      params.get("github") === "failed" ||
      params.get("hackatime") === "failed"
    )
      window.setTimeout(
        () => toast("Connection failed, check your OAuth settings"),
        0,
      );
    if (["auth", "github", "hackatime"].some((key) => params.has(key)))
      window.history.replaceState({}, "", window.location.pathname);
  }, [toast, refreshAvatarInventory]);

  const navigate = (next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleAvatarUpdated = useCallback((avatar: ResolvedAvatarConfig) => {
    setAuth((current) =>
      current.user
        ? { ...current, user: { ...current.user, avatar } }
        : current,
    );
  }, []);

  const saveExperience = async (experience: Experience) => {
    const response = await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experience }),
    });
    if (!response.ok) return toast("Could not save your placement level");
    setAuth((current) =>
      current.user
        ? { ...current, user: { ...current.user, experience } }
        : current,
    );
    setOnboardingOpen(false);
    toast(`Placement level set to ${experience}`);
  };

  const onMatched = useCallback(
    (match: ActiveMatch, media: MediaPrefs = { mic: true, video: true }) => {
      setMediaPrefs(media);
      setActiveMatch(match);
      setScreen("match");
      window.scrollTo({ top: 0 });
    },
    [],
  );

  const closePreAuthOnboarding = useCallback(() => {
    setPreAuthOpen(false);
    setPreAuthStep("avatar");
  }, []);
  const connectHackClub = useCallback(() => {
    window.localStorage.setItem(
      PENDING_AVATAR_KEY,
      JSON.stringify(avatarDraft),
    );
    window.location.assign("/api/auth/hackclub/start");
  }, [avatarDraft]);

  const logout = useCallback(async () => {
    if (logoutLoading) return;
    setLogoutLoading(true);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      if (!response.ok) throw new Error("Logout failed");
      await clearBrowserSiteData();
      window.location.replace("/");
    } catch {
      setLogoutLoading(false);
      toast("Could not log out, please try again");
    }
  }, [logoutLoading, toast]);

  const [incomingInvites, setIncomingInvites] = useState<
    Array<{ id: string; partnerName: string; partnerAvatar: AvatarConfig }>
  >([]);
  const acknowledgingMissed = useRef<Set<string>>(new Set());

  const globalInvitePollInFlight = useRef(false);
  const pollDuoInvites = useCallback(() => {
    if (globalInvitePollInFlight.current) return;
    globalInvitePollInFlight.current = true;
    fetchJsonWithTimeout<
      {
        incoming?: Array<{
          id: string;
          partnerName: string;
          partnerAvatar: AvatarConfig;
        }>;
        missed?: Array<{
          id: string;
          partnerName: string;
          partnerAvatar: AvatarConfig;
        }>;
      } & { error?: string }
    >("/api/duo-invites", {}, 8000)
      .then(({ response, data }) => (response.ok ? data : null))
      .then(
        (
          data: {
            incoming?: Array<{
              id: string;
              partnerName: string;
              partnerAvatar: AvatarConfig;
            }>;
            missed?: Array<{
              id: string;
              partnerName: string;
              partnerAvatar: AvatarConfig;
            }>;
          } | null,
        ) => {
          if (!data) return;
          setIncomingInvites(data.incoming ?? []);
          if (screen === "match") return;
          for (const missedInvite of data.missed ?? []) {
            if (acknowledgingMissed.current.has(missedInvite.id)) continue;
            acknowledgingMissed.current.add(missedInvite.id);
            toast(
              `${missedInvite.partnerName} invited you to duo while you were in a match`,
            );
            void fetch("/api/duo-invites", {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                inviteId: missedInvite.id,
                action: "acknowledge",
              }),
            });
          }
        },
      )
      .catch(() => undefined)
      .finally(() => {
        globalInvitePollInFlight.current = false;
      });
  }, [screen, toast]);

  useEffect(() => {
    if (!auth.user) return;
    pollDuoInvites();
    const poll = window.setInterval(pollDuoInvites, 4000);
    return () => window.clearInterval(poll);
  }, [auth.user, pollDuoInvites]);

  const respondToInvite = useCallback(
    async (inviteId: string, action: "accept" | "decline") => {
      try {
        const { response, data } = await fetchJsonWithTimeout<{
          error?: string;
        }>("/api/duo-invites", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ inviteId, action }),
        });
        if (!response.ok) {
          toast(data.error ?? "Could not respond to that invite");
          return;
        }
        setIncomingInvites((current) =>
          current.filter((invite) => invite.id !== inviteId),
        );
        if (action === "accept") {
          toast("You're teamed up!");
          navigate("lobby");
        }
      } catch (error) {
        toast(
          error instanceof Error
            ? error.message
            : "Could not respond to that invite — check your connection",
        );
      }
    },
    [toast],
  );

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen !== "match" && !(screen === "lobby" && auth.user) && (
        <SiteHeader
          screen={screen}
          navigate={navigate}
          onProfile={() => setProfileOpen(true)}
          balance={auth.user?.hBucks ?? 0}
          avatar={auth.user?.avatar}
          showAdmin={isAdmin(auth.user?.email)}
          wardrobeUnlocked={avatarInventory.size > 0}
          toast={toast}
        />
      )}
      {screen === "home" && (
        <Home
          navigate={navigate}
          toast={toast}
          auth={auth}
          startOnboarding={() => setPreAuthOpen(true)}
          customizeAvatar={() => {
            if (!auth.user) {
              setPreAuthStep("avatar");
              setPreAuthOpen(true);
              return;
            }
            if (avatarInventory.size > 0) navigate("wardrobe");
            else
              toast(
                "Buy your first avatar item in the Shop to unlock the Wardrobe",
              );
          }}
        />
      )}
      {screen === "lobby" && auth.user && (
        <Lobby
          navigate={navigate}
          toast={toast}
          user={auth.user}
          onMatched={onMatched}
        />
      )}
      {screen === "lobby" && !auth.user && (
        <Home
          navigate={navigate}
          toast={toast}
          auth={auth}
          startOnboarding={() => setPreAuthOpen(true)}
          customizeAvatar={() => {
            setPreAuthStep("avatar");
            setPreAuthOpen(true);
          }}
        />
      )}
      {screen === "match" && activeMatch && (
        <Match
          navigate={navigate}
          toast={toast}
          auth={auth}
          match={activeMatch}
          media={mediaPrefs}
        />
      )}
      {screen === "match" && !activeMatch && (
        <Home
          navigate={navigate}
          toast={toast}
          auth={auth}
          startOnboarding={() => setPreAuthOpen(true)}
          customizeAvatar={() => {
            if (!auth.user) {
              setPreAuthStep("avatar");
              setPreAuthOpen(true);
              return;
            }
            if (avatarInventory.size > 0) navigate("wardrobe");
            else
              toast(
                "Buy your first avatar item in the Shop to unlock the Wardrobe",
              );
          }}
        />
      )}
      {screen === "vote" && <Voting navigate={navigate} toast={toast} />}
      {screen === "leaderboard" && (
        <Leaderboard navigate={navigate} auth={auth} />
      )}
      {screen === "shop" && (
        <Shop
          navigate={navigate}
          toast={toast}
          auth={auth}
          avatarInventory={avatarInventory}
          onAvatarPurchased={refreshAvatarInventory}
        />
      )}
      {screen === "wardrobe" && (
        <Wardrobe
          navigate={navigate}
          toast={toast}
          auth={auth}
          avatarInventory={avatarInventory}
          onAvatarUpdated={handleAvatarUpdated}
        />
      )}
      {screen === "admin" && auth.user && isAdmin(auth.user.email) && (
        <AdminAuditLog navigate={navigate} />
      )}
      {profileOpen && (
        <ProfileModal
          close={() => setProfileOpen(false)}
          navigate={navigate}
          toast={toast}
          auth={auth}
          wardrobeUnlocked={avatarInventory.size > 0}
          logout={() => void logout()}
          logoutLoading={logoutLoading}
        />
      )}
      {preAuthOpen && !auth.user && (
        <OnboardingModal
          step={preAuthStep}
          avatar={avatarDraft}
          setAvatar={setAvatarDraft}
          onAvatarContinue={() => setPreAuthStep("hackclub")}
          onConnectHackClub={connectHackClub}
          onBackToAvatar={() => setPreAuthStep("avatar")}
          close={closePreAuthOnboarding}
        />
      )}
      {onboardingOpen && auth.user && (
        <OnboardingModal
          step={
            !auth.github
              ? "github"
              : !auth.hackatime
                ? "hackatime"
                : "placement"
          }
          onSelectExperience={(experience) => void saveExperience(experience)}
          close={() => setOnboardingOpen(false)}
        />
      )}
      {screen !== "match" && auth.user && incomingInvites.length > 0 && (
        <div className="global-invite-stack" role="alert">
          {incomingInvites.map((invite) => (
            <div className="global-invite-card" key={invite.id}>
              <ScribbleAvatar size="sm" avatar={invite.partnerAvatar} />
              <div>
                <strong>{invite.partnerName}</strong>
                <span>wants to duo with you</span>
              </div>
              <div className="invite-actions">
                <button
                  aria-label={`Accept ${invite.partnerName}'s invite`}
                  onClick={() => void respondToInvite(invite.id, "accept")}
                >
                  <Icon name="check" size={13} />
                </button>
                <button
                  aria-label={`Decline ${invite.partnerName}'s invite`}
                  onClick={() => void respondToInvite(invite.id, "decline")}
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className={`toast ${toastMessage ? "show" : ""}`} role="status">
        {toastMessage}
        <span>
          <Icon name="star" size={11} />
        </span>
      </div>
    </div>
  );
}
