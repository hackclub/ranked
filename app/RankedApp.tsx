"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollaborativeEditor } from "./realtime/CollaborativeEditor";
import { StreamVideo } from "./realtime/StreamVideo";
import { useCodeRoom, useRealtimeRoom } from "./realtime/useRealtimeRoom";
import { getYjsProviderForRoom } from "@liveblocks/yjs";
import { canUseTestLobby } from "./lib/test-lobby";

type Screen = "home" | "lobby" | "match" | "vote" | "leaderboard" | "shop";
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
    avatar: { color: string; eyes: number; mouths: number };
  } | null;
  github: { login: string; avatarUrl: string | null } | null;
};
type ActiveMatch = {
  id: string;
  mode: Mode | "admin";
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
    status: string;
    incoming: boolean;
  }>;
  recent: Array<{
    id: string;
    theme: string;
    status: string;
    createdAt: string;
    opponents: Array<{ id: string; name: string }>;
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

const COLORS = ["#D891D9", "#497CBF", "#CCD96C", "#D99F6C", "#BF5A5A"];

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
    <main><div class="planet"><h1>hello, orbit!</h1></div></main>
  </body>
</html>`,
  "styles.css": `body { margin: 0; font-family: system-ui; background: #08131f; color: #fff; }
main { min-height: 100vh; display: grid; place-items: center; overflow: hidden; }
.planet { width: 220px; aspect-ratio: 1; border-radius: 50%; background: #D891D9;
  box-shadow: 0 0 0 32px #497CBF22, 0 0 90px #D891D988; display: grid; place-items: center; }
h1 { font-size: 36px; transform: rotate(-4deg); }`,
  "script.js": `document.querySelector('.planet')?.addEventListener('click', () => {
  document.body.classList.toggle('clicked');
});`,
};

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
  | "star";

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
  star: <path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4Z" />,
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

function ScribbleAvatar({
  color = COLORS[1],
  eyes = 2,
  mouths = 1,
  size = "lg",
  label = "Player avatar",
}: {
  color?: string;
  eyes?: number;
  mouths?: number;
  size?: "sm" | "md" | "lg";
  label?: string;
}) {
  return (
    <div
      className={`scribble-avatar avatar-${size}`}
      style={{ "--avatar": color } as React.CSSProperties}
      role="img"
      aria-label={label}
    >
      <div className="scribble-ring ring-one" />
      <div className="scribble-ring ring-two" />
      <div className="avatar-face">
        <div className="eyes">
          {Array.from({ length: eyes }).map((_, i) => (
            <i key={i} />
          ))}
        </div>
        <div className="mouths">
          {Array.from({ length: mouths }).map((_, i) => (
            <b key={i} />
          ))}
        </div>
      </div>
      <div className="avatar-legs">
        <i />
        <i />
      </div>
    </div>
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
        <span>1500</span>
        <strong>{elo} ELO</strong>
        <span>celestial at 3000</span>
      </div>
      <div className="rank-track">
        <div className="rank-fill" style={{ width: `${progress}%` }} />
        <i className="rank-dot" style={{ left: `${progress}%` }} />
      </div>
      <div className="rank-meta">
        <span>meteor</span>
        <span>{Math.max(0, 3000 - elo)} to celestial</span>
      </div>
    </div>
  );
}

function SiteHeader({
  screen,
  navigate,
  onProfile,
  balance,
  avatar,
}: {
  screen: Screen;
  navigate: (s: Screen) => void;
  onProfile: () => void;
  balance: number;
  avatar?: { color: string; eyes: number; mouths: number };
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
      </nav>
      <Logo />
      <button
        className="profile-button"
        onClick={onProfile}
        aria-label="Open profile and account settings"
      >
        <ScribbleAvatar
          size="sm"
          color={avatar?.color}
          eyes={avatar?.eyes}
          mouths={avatar?.mouths}
        />
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

function Home({
  navigate,
  toast,
  auth,
  startOnboarding,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
  startOnboarding: () => void;
}) {
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
      .slice(0, 5) ?? [];

  useEffect(() => {
    if (!auth.user) return;
    fetch("/api/dashboard")
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => data && setDashboard(data))
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
    const response = await fetch("/api/friends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUserId: id }),
    });
    const result = await response.json();
    if (!response.ok)
      return toast(result.error ?? "Could not send that request");
    setFriendRequests((current) => [...current, id]);
    toast(`Friend request sent to @${name}`);
  };

  const addSlackFriend = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selectedFriend) {
      const response = await fetch("/api/friends", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: selectedFriend.id }),
      });
      const result = await response.json();
      if (!response.ok)
        return toast(result.error ?? "Could not send that friend request");
      setSlackQuery("");
      setSelectedFriend(null);
      return toast("Friend request sent");
    }
    const handle = slackQuery.replace(/^@/, "").trim();
    if (!handle) return;
    const message = `${auth.user?.name ?? "Someone"} has invited you to match-up on Hack Club Ranked! Join the match: <https://ranked.hackclub.com?utm_source=game_invite|ranked.hackclub.com>`;
    void navigator.clipboard.writeText(message);
    setSlackQuery("");
    toast(`@${handle} hasn't joined Ranked yet — copied invite to clipboard`);
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
                onClick={() =>
                  toast(
                    "Connect Hack Club Slack in your profile to find friends",
                  )
                }
              >
                <Icon name="plus" size={13} />
              </button>
            </CardTitle>
            <ul className="people-list">
              {dashboard?.friends.length ? (
                dashboard.friends.map((friend) => (
                  <li key={friend.id}>
                    <span className="mini-face blue">{friend.name[0]}</span>
                    <div>
                      <strong>{friend.name}</strong>
                      <small>
                        {friend.status === "accepted"
                          ? "friend"
                          : friend.incoming
                            ? "request received"
                            : "request sent"}
                      </small>
                    </div>
                    {friend.status === "pending" && friend.incoming ? (
                      <button
                        onClick={() => void acceptFriend(friend.friendshipId)}
                      >
                        accept
                      </button>
                    ) : (
                      <i className="status" />
                    )}
                  </li>
                ))
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
                  value={slackQuery}
                  onChange={(event) => {
                    setSlackQuery(event.target.value);
                    setSelectedFriend(null);
                    setSlackSuggestionsOpen(true);
                  }}
                  onFocus={() => setSlackSuggestionsOpen(true)}
                  onBlur={() => setSlackSuggestionsOpen(false)}
                  placeholder="@slack username"
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
                          <small>{member.email}</small>
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
                recentInteractions.map((interaction, index) => (
                  <li key={`${interaction.matchId}-${interaction.id}`}>
                    <span
                      className="interaction-avatar"
                      style={{ background: COLORS[index % COLORS.length] }}
                    >
                      {interaction.name[0].toUpperCase()}
                    </span>
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
          <ScribbleAvatar
            color={auth.user?.avatar.color}
            eyes={auth.user?.avatar.eyes}
            mouths={auth.user?.avatar.mouths}
            label="Your scribble avatar"
          />
          <div className="hero-copy">
            <button
              className="primary-button start-button"
              onClick={() =>
                auth.user ? navigate("lobby") : startOnboarding()
              }
            >
              {auth.user ? "find a match" : "sign in to play"}{" "}
              <Icon name="external" size={18} />
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
            <button
              onClick={() => navigate("vote")}
              disabled={!dashboard?.voteGate.available}
            >
              vote now
            </button>
          </div>
        </aside>
      </section>
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

      {challenges.map((challenge) => (
        <Challenge
          key={challenge.type}
          label={
            challenge.type === "play_matches"
              ? "Play 2 matches"
              : challenge.type === "code_seconds"
                ? "Code for 3 hours"
                : "Add 2 friends"
          }
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
      <small className="resets">resets in {resetsIn}</small>
    </div>
  );
}

type OnboardingStep = "avatar" | "hackclub" | "github" | "placement";
type AvatarDraft = { color: string; eyes: number; mouths: number };
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
              it weird, you won’t be able to change it after today.
            </p>
            <AvatarCustomizer
              color={avatar.color}
              setColor={(color) => setAvatar({ ...avatar, color })}
              eyes={avatar.eyes}
              setEyes={(eyes) => setAvatar({ ...avatar, eyes })}
              mouths={avatar.mouths}
              setMouths={(mouths) => setAvatar({ ...avatar, mouths })}
            />
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
                color={avatar.color}
                eyes={avatar.eyes}
                mouths={avatar.mouths}
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
            <h2 id="onboarding-title">Connect GitHub.</h2>
            <p>
              Every finished match gets published as a folder inside{" "}
              <strong>hackclubranked</strong>, one shared repo on your account,
              and deployed live with GitHub Pages. Connect it now so publishing
              is instant the moment your first match ends.
            </p>
            <a className="primary-button" href="/api/auth/github/start">
              <Icon name="github" size={16} /> connect GitHub
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

function AvatarCustomizer({
  color,
  setColor,
  eyes,
  setEyes,
  mouths,
  setMouths,
}: {
  color: string;
  setColor: (c: string) => void;
  eyes: number;
  setEyes: (n: number) => void;
  mouths: number;
  setMouths: (n: number) => void;
}) {
  return (
    <div className="avatar-customizer">
      <span className="eyebrow">your scribble</span>
      <div className="avatar-stage">
        <ScribbleAvatar color={color} eyes={eyes} mouths={mouths} />
      </div>
      <div className="customize-row">
        <span>color</span>
        <div className="swatches">
          {COLORS.map((c) => (
            <button
              key={c}
              className={c === color ? "selected" : ""}
              style={{ background: c }}
              onClick={() => setColor(c)}
              aria-label={`Choose ${c}`}
            />
          ))}
        </div>
      </div>
      <div className="customize-row">
        <span>eyes</span>
        <div className="stepper">
          <button
            aria-label="Fewer eyes"
            onClick={() => setEyes(Math.max(1, eyes - 1))}
          >
            <Icon name="minus" size={14} />
          </button>
          <b>{eyes}</b>
          <button
            aria-label="More eyes"
            onClick={() => setEyes(Math.min(5, eyes + 1))}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
      <div className="customize-row">
        <span>mouths</span>
        <div className="stepper">
          <button
            aria-label="Fewer mouths"
            onClick={() => setMouths(Math.max(1, mouths - 1))}
          >
            <Icon name="minus" size={14} />
          </button>
          <b>{mouths}</b>
          <button
            aria-label="More mouths"
            onClick={() => setMouths(Math.min(3, mouths + 1))}
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>
      <button
        className="shuffle-button"
        onClick={() => {
          setColor(COLORS[Math.floor(Math.random() * COLORS.length)]);
          setEyes(1 + Math.floor(Math.random() * 5));
          setMouths(1 + Math.floor(Math.random() * 3));
        }}
      >
        <Icon name="shuffle" size={13} /> shuffle me
      </button>
    </div>
  );
}

type DuoInvitePartner = {
  id: string;
  partnerId: string;
  partnerName: string;
  partnerAvatar: { color: string; eyes: number; mouths: number };
  partnerQueued?: boolean;
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
  avatar: { color: string; eyes: number; mouths: number };
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
  const [challenges, setChallenges] = useState<DashboardData["challenges"]>([]);
  const resetsIn = useCountdownToUtcMidnight();

  const acceptQueueResult = useCallback(
    (result: {
      status?: string;
      match?: ActiveMatch;
      error?: string;
      code?: string;
    }) => {
      if (result.match)
        return onMatched(result.match, {
          mic,
          video,
          micDeviceId: micDeviceId || undefined,
          videoDeviceId: videoDeviceId || undefined,
        });
      if (result.code === "vote_required") {
        setMatching(false);
        toast(result.error ?? "Vote required");
        navigate("vote");
      }
    },
    [mic, micDeviceId, navigate, onMatched, toast, video, videoDeviceId],
  );

  const ready = async () => {
    if (matching) {
      setMatching(false);
      await fetch("/api/matchmaking/queue", { method: "DELETE" });
      toast("Left the queue, change anything and ready up again");
      return;
    }
    setMatching(true);
    await fetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ experience }),
    });
    const response = await fetch("/api/matchmaking/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, durationMinutes: length, experience }),
    });
    const result = await response.json();
    if (!response.ok && result.code !== "vote_required") {
      setMatching(false);
      toast(result.error ?? "Could not join the queue");
      return;
    }
    acceptQueueResult(result);
  };

  const testEmptyLobby = async () => {
    const response = await fetch("/api/matchmaking/test-match", {
      method: "POST",
    });
    const result = await response.json();
    if (!response.ok)
      return toast(result.error ?? "Could not start a test lobby");
    acceptQueueResult(result);
  };

  useEffect(() => {
    if (!matching) return;
    const poll = window.setInterval(
      () =>
        fetch("/api/matchmaking/queue")
          .then((response) => response.json())
          .then(acceptQueueResult)
          .catch(() => undefined),
      2000,
    );
    return () => window.clearInterval(poll);
  }, [acceptQueueResult, matching]);

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

  const fetchDuoState = useCallback(() => {
    fetch("/api/duo-invites")
      .then((response) => response.json())
      .then(setDuoState)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (mode !== "duo") return;
    fetchDuoState();
    const poll = window.setInterval(fetchDuoState, 3000);
    return () => window.clearInterval(poll);
  }, [fetchDuoState, mode]);

  const sendInvite = async (friendId: string) => {
    setInviteBusy(true);
    const response = await fetch("/api/duo-invites", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ friendId }),
    });
    const result = await response.json();
    setInviteBusy(false);
    if (!response.ok) return toast(result.error ?? "Could not send invite");
    setDuoState((current) => ({ ...current, outgoing: result.outgoing }));
    toast(`Invite sent to ${result.outgoing.partnerName}`);
  };

  const respondInvite = async (
    inviteId: string,
    action: "accept" | "decline",
  ) => {
    const response = await fetch("/api/duo-invites", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inviteId, action }),
    });
    if (!response.ok) return toast("Could not respond to that invite");
    fetchDuoState();
    if (action === "accept") toast("You're teamed up!");
  };

  const cancelDuo = async () => {
    await fetch("/api/duo-invites", { method: "DELETE" });
    setDuoState({ partner: null, outgoing: null, incoming: [] });
  };

  return (
    <main className="lobby-screen">
      <div className="w-full justify-end">
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
          {mode === "duo" && duoState.incoming.length > 0 && (
            <aside className="hud-panel">
              <span className="hud-label">duo invite</span>
              <ul className="invite-list">
                {duoState.incoming.map((invite) => (
                  <li className="invite-row" key={invite.id}>
                    <ScribbleAvatar
                      size="sm"
                      color={invite.partnerAvatar.color}
                      eyes={invite.partnerAvatar.eyes}
                      mouths={invite.partnerAvatar.mouths}
                    />
                    <div>
                      <strong>{invite.partnerName}</strong>
                      <span>wants to duo with you</span>
                    </div>
                    <div className="invite-actions">
                      <button
                        aria-label={`Accept ${invite.partnerName}'s invite`}
                        onClick={() => void respondInvite(invite.id, "accept")}
                      >
                        <Icon name="check" size={13} />
                      </button>
                      <button
                        aria-label={`Decline ${invite.partnerName}'s invite`}
                        onClick={() => void respondInvite(invite.id, "decline")}
                      >
                        ×
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </aside>
          )}
          <DailyChallenges challenges={challenges} resetsIn={resetsIn} />

          <div className="match-dock">
            <button
              className={`primary-button match-dock-button ${matching ? "matching" : ""}`}
              onClick={() => void ready()}
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
                <i className="dock-dot" /> contacting matchmaking service…
              </p>
            )}
            {canUseTestLobby(user.email) && !matching && (
              <button
                className="test-lobby-button"
                onClick={() => void testEmptyLobby()}
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
                  color={user.avatar.color}
                  eyes={user.avatar.eyes}
                  mouths={user.avatar.mouths}
                  size={mode === "duo" ? "md" : "lg"}
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
                    <div className="pedestal-avatar">
                      <ScribbleAvatar
                        color={duoState.partner.partnerAvatar.color}
                        eyes={duoState.partner.partnerAvatar.eyes}
                        mouths={duoState.partner.partnerAvatar.mouths}
                        size="md"
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
                      leave
                    </button>
                  </>
                ) : duoState.outgoing ? (
                  <>
                    <div className="pedestal-ring dashed" />
                    <ScribbleAvatar
                      color={duoState.outgoing.partnerAvatar.color}
                      eyes={duoState.outgoing.partnerAvatar.eyes}
                      mouths={duoState.outgoing.partnerAvatar.mouths}
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
                      onClick={() => setAddOpen((open) => !open)}
                    >
                      <Icon name="plus" size={22} />
                    </button>
                    <strong>open slot</strong>
                    {addOpen && (
                      <>
                        <div
                          className="popover-backdrop"
                          onClick={() => setAddOpen(false)}
                        />
                        <div
                          className="invite-popover"
                          role="dialog"
                          aria-label="Invite a friend"
                        >
                          <span className="invite-popover-title">
                            invite a friend
                          </span>
                          {friends.length ? (
                            <ul className="invite-friend-list">
                              {friends.map((friend) => (
                                <li key={friend.userId}>
                                  <ScribbleAvatar
                                    size="sm"
                                    color={friend.avatar.color}
                                    eyes={friend.avatar.eyes}
                                    mouths={friend.avatar.mouths}
                                  />
                                  <strong>{friend.name}</strong>
                                  <button
                                    disabled={inviteBusy}
                                    onClick={() => {
                                      void sendInvite(friend.userId);
                                      setAddOpen(false);
                                    }}
                                  >
                                    invite
                                  </button>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className="invite-empty">
                              Add friends from a recent match first.
                            </p>
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
          <div className="hud-block">
            <span className="hud-label">team size</span>
            <div className="segmented">
              <button
                className={mode === "solo" ? "active" : ""}
                onClick={() => setMode("solo")}
              >
                <Icon name="person" size={18} />
                <span>
                  solo<small>1 vs 1</small>
                </span>
              </button>
              <button
                className={mode === "duo" ? "active" : ""}
                onClick={() => setMode("duo")}
              >
                <Icon name="people" size={18} />
                <span>
                  duos<small>2 vs 2</small>
                </span>
              </button>
            </div>
          </div>
          <div className="hud-block">
            <span className="hud-label">match length</span>
            <div className="time-options">
              {[10, 30, 60].map((time) => (
                <button
                  key={time}
                  className={length === time ? "active" : ""}
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
            <div className="camera-preview">
              {video && previewStream && !previewError ? (
                <video
                  ref={previewVideoRef}
                  autoPlay
                  playsInline
                  muted
                  className="camera-preview-video"
                />
              ) : (
                <div className="camera-preview-placeholder">
                  <ScribbleAvatar
                    color={user.avatar.color}
                    eyes={user.avatar.eyes}
                    mouths={user.avatar.mouths}
                    size="sm"
                  />
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
        <small className="lobby-fineprint">
          By joining, you agree to abide by the{" "}
          <a href="https://hackclub.com/conduct" className="black bold">
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

function VideoTile({
  name,
  team,
  color,
  eyes = 2,
  mouths = 1,
  muted = false,
  stream,
  local = false,
  audioMuted = false,
}: {
  name: string;
  team: string;
  color: string;
  eyes?: number;
  mouths?: number;
  muted?: boolean;
  stream?: MediaStream | null;
  local?: boolean;
  audioMuted?: boolean;
}) {
  return (
    <div
      className="video-tile"
      style={{ "--tile": color } as React.CSSProperties}
    >
      {stream ? (
        <StreamVideo
          stream={stream}
          muted={local || audioMuted}
          label={`${name}'s live video`}
        />
      ) : (
        <ScribbleAvatar
          color={color}
          eyes={eyes}
          mouths={mouths}
          size="md"
          label={`${name}'s camera placeholder`}
        />
      )}
      <div className="video-label">
        <span>
          <i />
          {name}
        </span>
        <small>{team}</small>
      </div>
      {muted && <span className="muted-badge">mic off</span>}
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
  const [tab, setTab] = useState("index.html");
  const [mic, setMic] = useState(media.mic);
  const [video, setVideo] = useState(media.video);
  const [scope, setScope] = useState<"team" | "everyone">("team");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [syncIn, setSyncIn] = useState(18);
  const [opponentSnapshot, setOpponentSnapshot] = useState<string | null>(null);
  const [publishOpen, setPublishOpen] = useState(false);
  const [forfeitOpen, setForfeitOpen] = useState(false);
  const [forfeitLoading, setForfeitLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [disconnect, setDisconnect] = useState<DisconnectNotice | null>(null);
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [buildName, setBuildName] = useState("");
  const [publishState, setPublishState] = useState<{
    loading: boolean;
    error?: string;
    repositoryUrl?: string;
    pagesUrl?: string;
  }>({ loading: false });
  const team = match.team;
  const { status, localStream, remotePeers } = useRealtimeRoom(
    `ranked:call:${match.id}`,
    mic,
    video,
    scope,
    team,
    media.micDeviceId,
    media.videoDeviceId,
  );
  const room = useCodeRoom(`ranked:code:${match.id}:${team}`);

  useEffect(() => {
    if (!room) return;
    const provider = getYjsProviderForRoom(room, {
      offlineSupport_experimental: true,
    });
    const texts = Object.keys(starterFiles).map((name) => ({
      name,
      text: provider.getYDoc().getText(`file:${name}`),
    }));
    const syncAll = () =>
      setFiles((current) =>
        Object.fromEntries(
          texts.map(({ name, text }) => [
            name,
            text.length ? text.toString() : current[name],
          ]),
        ),
      );
    const seedAll = (synced: boolean) => {
      if (!synced) return;
      for (const { name, text } of texts)
        if (!text.length) text.insert(0, starterFiles[name]);
      syncAll();
    };
    for (const { text } of texts) text.observe(syncAll);
    provider.on("sync", seedAll);
    seedAll(provider.synced);
    return () => {
      for (const { text } of texts) text.unobserve(syncAll);
      provider.off("sync", seedAll);
    };
  }, [room]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds((s) => Math.max(0, s - 1));
      setSyncIn((s) => (s <= 1 ? 30 : s - 1));
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
  const previewDoc = useMemo(() => {
    const withStyles = files["index.html"].includes("</head>")
      ? files["index.html"].replace(
          "</head>",
          `<style>${files["styles.css"]}</style></head>`,
        )
      : `<style>${files["styles.css"]}</style>${files["index.html"]}`;
    return withStyles.includes("</body>")
      ? withStyles.replace(
          "</body>",
          `<script>${files["script.js"]}<\/script></body>`,
        )
      : `${withStyles}<script>${files["script.js"]}<\/script>`;
  }, [files]);
  const previewDocRef = useRef(previewDoc);
  useEffect(() => {
    previewDocRef.current = previewDoc;
  }, [previewDoc]);
  const updateCurrentFile = useCallback(
    (value: string) => {
      setFiles((current) => ({ ...current, [tab]: value }));
    },
    [tab],
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
    setPublishState({ loading: true });
    try {
      const response = await fetch("/api/github/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          matchId: match.id,
          name: buildName,
          html: previewDoc,
          files,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        repositoryUrl?: string;
        pagesUrl?: string;
      };
      if (!response.ok || !result.repositoryUrl || !result.pagesUrl)
        throw new Error(result.error ?? "Publishing failed.");
      setPublishState({
        loading: false,
        repositoryUrl: result.repositoryUrl,
        pagesUrl: result.pagesUrl,
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
    match.id,
    previewDoc,
    publishState.loading,
    publishState.repositoryUrl,
    buildName,
    toast,
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

  useEffect(() => {
    const sync = async () => {
      await fetch(`/api/matches/${match.id}/snapshot`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ html: previewDocRef.current }),
      });
      const response = await fetch(`/api/matches/${match.id}/snapshot`);
      if (response.ok) {
        const result = (await response.json()) as {
          snapshot?: { html?: string } | null;
        };
        if (result.snapshot?.html) setOpponentSnapshot(result.snapshot.html);
      }
      setSyncIn(30);
    };
    const initial = window.setTimeout(() => void sync(), 1000);
    const interval = window.setInterval(() => void sync(), 30_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [match.id]);

  useEffect(() => {
    if (seconds === 0 && !outcome)
      window.setTimeout(() => setPublishOpen(true), 0);
  }, [outcome, seconds]);

  const isTestMatch = match.mode === "admin";
  const canSkipPublish = isTestMatch && canUseTestLobby(auth.user?.email ?? "");

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
        <button className="match-logo" onClick={() => navigate("home")}>
          R/
        </button>
        <div className="theme-tag">
          <span>theme</span>
          <strong>{match.theme}</strong>
        </div>
        <div className="timer" aria-label={`${time} remaining`}>
          <span>{time}</span>
          <small>remaining</small>
        </div>
        <div />
        <div className="match-actions">
          <button
            className="settings-gear"
            onClick={() => setSettingsOpen(true)}
            aria-label="Match settings"
          >
            <Icon name="settings" size={17} />
          </button>
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
            <span className="eyebrow">match settings</span>
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
      <section className="call-strip">
        <div className={`call-team ${match.mode === "duo" ? "" : "solo"}`}>
          <span className="call-label">
            {match.mode === "duo" ? "YOUR DUO" : "YOU"}
          </span>
          <VideoTile
            name={auth.user?.name ?? "you"}
            team={`${team} · you`}
            color={auth.user?.avatar.color ?? COLORS[1]}
            eyes={auth.user?.avatar.eyes}
            mouths={auth.user?.avatar.mouths}
            stream={video ? localStream : null}
            local
            muted={!mic}
          />
          {match.mode === "duo" && (
            <VideoTile
              name={teammate?.name ?? "waiting…"}
              team={teammate ? "teammate · live" : "waiting for teammate"}
              color={teammate?.color ?? COLORS[2]}
              stream={teammate?.video ? teammate.stream : null}
              muted={teammate ? !teammate.mic : false}
            />
          )}
        </div>
        <div
          className={`call-team opponents ${match.mode === "duo" ? "" : "solo"}`}
        >
          <span className="call-label">
            {match.mode === "duo" ? "OPPONENTS" : "OPPONENT"}
          </span>
          {(match.mode === "duo" ? [0, 1] : [0]).map((index) => {
            const peer = opponents[index];
            return (
              <VideoTile
                key={peer?.connectionId ?? index}
                name={peer?.name ?? "open slot"}
                team={peer ? `${peer.team} team` : "waiting for builder"}
                color={peer?.color ?? COLORS[index + 3]}
                stream={peer?.video ? peer.stream : null}
                muted={peer ? !peer.mic : false}
                audioMuted={scope === "team" && peer?.team !== team}
              />
            );
          })}
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
        </div>
      </section>
      <section className="workspace">
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="file-tabs">
              {["index.html", "styles.css", "script.js"].map((file) => (
                <button
                  key={file}
                  onClick={() => setTab(file)}
                  className={tab === file ? "active" : ""}
                >
                  <i className={`file-dot ${file.split(".")[1]}`} />
                  {file}
                  {tab === file && <span>×</span>}
                </button>
              ))}
            </div>
            <div className="collab-state">
              <div className="face-stack">
                <i>{auth.user?.name?.[0] ?? "Y"}</i>
                {remotePeers.slice(0, 2).map((peer) => (
                  <i key={peer.connectionId}>{peer.name[0]}</i>
                ))}
              </div>
              <span>{remotePeers.length + 1} editing</span>
              <b>{status === "connected" ? "synced" : status}</b>
            </div>
          </div>
          <div className="editor-area">
            <aside className="file-rail">
              <button className="active" aria-label="Files">
                <Icon name="files" size={17} />
              </button>
              <button aria-label="Search">
                <Icon name="search" size={17} />
              </button>
              <button aria-label="Source control">
                <Icon name="branch" size={17} />
              </button>
              <span />
              <button aria-label="Settings">
                <Icon name="settings" size={17} />
              </button>
            </aside>
            <CollaborativeEditor
              room={room}
              file={tab}
              initialValue={starterFiles[tab]}
              onChange={updateCurrentFile}
            />
          </div>
          <footer className="editor-status">
            <span>main*</span>
            <span>spaces: 2</span>
            <span>utf-8</span>
            <b>Liveblocks · {status}</b>
          </footer>
        </div>
        <aside className="preview-panel">
          <div className="preview-head">
            <div>
              <strong>your website</strong>
            </div>
            <div className="browser-dots">
              <i />
              <i />
              <i />
            </div>
            <button onClick={() => setPreviewOpen(!previewOpen)}>
              {previewOpen ? "hide" : "expand"}{" "}
              <Icon name="external" size={11} />
            </button>
          </div>
          <iframe
            title="Your website live preview"
            srcDoc={previewDoc}
            sandbox="allow-scripts"
          />
          <div className="opponent-snapshot">
            <div>
              <span className="eyebrow">OPPONENT SNAPSHOT</span>
              <strong>update in {syncIn}s</strong>
            </div>
            {opponentSnapshot ? (
              <iframe
                title="Opponent website snapshot"
                srcDoc={opponentSnapshot}
                sandbox="allow-scripts"
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
              onClick={() =>
                toast("Snapshots sync automatically every 30 seconds")
              }
            >
              live sync <small>server verified</small>
            </button>
          </div>
        </aside>
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
              title="Expanded live preview"
              srcDoc={previewDoc}
              sandbox="allow-scripts"
            />
          </div>
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
            <span className="eyebrow">match complete · your GitHub copy</span>
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
                  <a
                    href={publishState.pagesUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    open live website <Icon name="external" size={11} />
                  </a>
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
                  <span>{auth.github?.login ?? "you"}/hackclubranked/</span>
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
                    pattern="[A-Za-z0-9._-]+"
                    required
                  />
                </label>
                {publishState.error && (
                  <p className="publish-error">{publishState.error}</p>
                )}
                {auth.github ? (
                  <button
                    className="primary-button"
                    onClick={() => void publish()}
                    disabled={publishState.loading || !buildName}
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
            <span className="eyebrow">leave this match</span>
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
            <span className="eyebrow">
              {isTestMatch
                ? "test match closed"
                : `match closed · ${outcome.endReason}`}
            </span>
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

function Leaderboard({ navigate }: { navigate: (s: Screen) => void }) {
  const [board, setBoard] = useState<"elo" | "hours">("elo");
  const [rows, setRows] = useState<
    Array<{
      id: string;
      name: string;
      score: number | string;
      matchesPlayed: number;
    }>
  >([]);
  useEffect(() => {
    fetch(`/api/leaderboard?type=${board}`)
      .then((response) => response.json())
      .then((result) => setRows(result.players ?? []))
      .catch(() => setRows([]));
  }, [board]);
  return (
    <main className="subpage screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>
        ← back to base
      </button>
      <div className="subpage-head">
        <span className="eyebrow">global rankings</span>
        <h1>Builders on a roll.</h1>
        <p>
          Win community votes, climb the ladder, and keep shipping strange
          little websites.
        </p>
      </div>
      <div className="board-toggle">
        <button
          className={board === "elo" ? "active" : ""}
          onClick={() => setBoard("elo")}
        >
          highest ELO
        </button>
        <button
          className={board === "hours" ? "active" : ""}
          onClick={() => setBoard("hours")}
        >
          most hours
        </button>
      </div>
      <section className="leader-card">
        <div className="leader-row leader-head">
          <span>rank</span>
          <span>builder</span>
          <span>{board === "elo" ? "ELO" : "hours"}</span>
          <span>matches</span>
        </div>
        {rows.map((row, index) => (
          <div className="leader-row" key={row.id}>
            <strong>#{index + 1}</strong>
            <span>
              <i style={{ background: COLORS[index % COLORS.length] }}>
                {row.name[0].toUpperCase()}
              </i>
              <b>{row.name}</b>
            </span>
            <strong>{row.score}</strong>
            <span>{row.matchesPlayed}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

const products: Array<[string, string, string, string, IconName, string]> = [
  [
    "stickers",
    "Ranked sticker pack",
    "Cover absolutely everything.",
    "100",
    "sticker",
    COLORS[0],
  ],
  [
    "flipper",
    "Flipper Zero",
    "For curious hardware hackers.",
    "4500",
    "flipper",
    COLORS[4],
  ],
  ["ipad", "iPad", "Sketch the next strange thing.", "9000", "ipad", COLORS[2]],
  [
    "macbook",
    "MacBook Air",
    "A lot of hours. Very worth it.",
    "18000",
    "macbook",
    COLORS[1],
  ],
];

function Shop({
  navigate,
  toast,
  auth,
}: {
  navigate: (s: Screen) => void;
  toast: (m: string) => void;
  auth: AuthState;
}) {
  const [selected, setSelected] = useState<(typeof products)[number] | null>(
    null,
  );
  const [balance, setBalance] = useState(auth.user?.hBucks ?? 0);
  useEffect(() => {
    if (auth.user)
      fetch("/api/shop/orders")
        .then((r) => r.json())
        .then((data) => setBalance(data.balance ?? 0))
        .catch(() => undefined);
  }, [auth.user]);
  const redeem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const shipping = Object.fromEntries(form.entries());
    const response = await fetch("/api/shop/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: selected[0], shipping }),
    });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Redemption failed");
    setBalance(result.balance);
    setSelected(null);
    toast("Redemption submitted for approval");
  };
  return (
    <main className="subpage shop-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>
        ← back to base
      </button>
      <div className="subpage-head">
        <span className="eyebrow">the H-Bucks shop</span>
        <h1>Code time pays.</h1>
        <p>
          Earn 10 H-Bucks for every focused hour. Save up for real tech,
          stickers, and hacker gear.
        </p>
        <div className="balance">
          your balance <strong>{balance} Ħ</strong>
        </div>
      </div>
      <section className="product-grid">
        {products.map((product) => {
          const [id, name, desc, price, icon, color] = product;
          return (
            <article
              key={id}
              className="product-card"
              style={{ "--product": color } as React.CSSProperties}
            >
              <div className="product-art">
                <Icon name={icon} size={56} />
              </div>
              <span className="eyebrow">ships worldwide</span>
              <h2>{name}</h2>
              <p>{desc}</p>
              <div>
                <strong>{Number(price).toLocaleString()} Ħ</strong>
                <button
                  onClick={() =>
                    Number(price) > balance
                      ? toast(
                          `Keep building, you need more H-Bucks for ${name}`,
                        )
                      : setSelected(product)
                  }
                >
                  redeem
                </button>
              </div>
            </article>
          );
        })}
      </section>
      {selected && (
        <div className="modal-backdrop">
          <form
            className="modal shipping-modal"
            onSubmit={(event) => void redeem(event)}
          >
            <button
              type="button"
              className="close-button"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <span className="eyebrow">secure redemption</span>
            <h2>Ship your {selected[1]}</h2>
            <input name="name" placeholder="Full name" required />
            <input name="address1" placeholder="Address" required />
            <input name="address2" placeholder="Apartment / suite" />
            <input name="city" placeholder="City" required />
            <input name="region" placeholder="State / region" required />
            <input name="postalCode" placeholder="Postal code" required />
            <input name="country" placeholder="Country" required />
            <button className="primary-button" type="submit">
              redeem {Number(selected[3]).toLocaleString()} Ħ
            </button>
          </form>
        </div>
      )}
    </main>
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
    sites: Record<"blue" | "red", { pagesUrl: string; repositoryUrl: string }>;
  } | null>(null);
  useEffect(() => {
    fetch("/api/votes")
      .then((r) => r.json())
      .then((data) => setMatch(data.match ?? null))
      .catch(() => undefined);
  }, []);
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
    toast("Vote counted, your next match is unlocked");
  };
  return (
    <main className="vote-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>
        ← back to base
      </button>
      <div className="vote-heading">
        <span className="eyebrow">
          community vote{match ? ` · theme: ${match.theme}` : ""}
        </span>
        <h1>{match ? "Which build hits harder?" : "You’re caught up."}</h1>
        <p>
          {match
            ? "Judge the finished site, not the player. Open both, explore, then cast one vote."
            : "There are no eligible finished matches waiting for your vote right now."}
        </p>
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
                />
              </div>
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
                />
              </div>
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
              <span>
                Results reveal when the vote closes. Both builds will be
                open-sourced on GitHub.
              </span>
              <button onClick={() => navigate("lobby")}>
                play another <Icon name="external" size={11} />
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function ProfileModal({
  close,
  auth,
  logout,
  logoutLoading,
}: {
  close: () => void;
  auth: AuthState;
  logout: () => void;
  logoutLoading: boolean;
}) {
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
        <ScribbleAvatar
          color={auth.user?.avatar.color}
          eyes={auth.user?.avatar.eyes}
          mouths={auth.user?.avatar.mouths}
          size="md"
        />
        <div>
          <span className="eyebrow">your account</span>
          <h2 id="profile-title">{auth.user?.name ?? "Guest builder"}</h2>
          <p>
            {auth.user
              ? `${auth.user.email} · ${auth.user.elo} ELO · ${Math.round(auth.user.codingSeconds / 360) / 10}h`
              : "Sign in to join matches"}
          </p>
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
  const [auth, setAuth] = useState<AuthState>({ user: null, github: null });
  const [activeMatch, setActiveMatch] = useState<ActiveMatch | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [preAuthOpen, setPreAuthOpen] = useState(false);
  const [preAuthStep, setPreAuthStep] = useState<"avatar" | "hackclub">(
    "avatar",
  );
  const [avatarDraft, setAvatarDraft] = useState<AvatarDraft>({
    color: COLORS[1],
    eyes: 2,
    mouths: 1,
  });
  const [mediaPrefs, setMediaPrefs] = useState<MediaPrefs>({
    mic: true,
    video: true,
  });
  const [logoutLoading, setLogoutLoading] = useState(false);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 2600);
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
            const pendingAvatar = JSON.parse(pendingAvatarRaw) as AvatarDraft;
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
          Boolean(next.user && (!next.github || !next.user.experience)),
        );
        if (next.user) {
          const queue = await fetch("/api/matchmaking/queue")
            .then((response) => response.json())
            .catch(() => null);
          if (queue?.match) {
            setActiveMatch(queue.match);
            setScreen("match");
          }
        }
      })
      .catch(() => setAuth({ user: null, github: null }));
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "connected")
      window.setTimeout(() => toast("Hack Club account connected"), 0);
    if (params.get("github") === "connected")
      window.setTimeout(
        () => toast("GitHub connected, publishing is ready"),
        0,
      );
    if (params.get("auth") === "failed" || params.get("github") === "failed")
      window.setTimeout(
        () => toast("Connection failed, check your OAuth settings"),
        0,
      );
    if (["auth", "github"].some((key) => params.has(key)))
      window.history.replaceState({}, "", window.location.pathname);
  }, [toast]);

  const navigate = (next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

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

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen !== "match" && (
        <SiteHeader
          screen={screen}
          navigate={navigate}
          onProfile={() => setProfileOpen(true)}
          balance={auth.user?.hBucks ?? 0}
          avatar={auth.user?.avatar}
        />
      )}
      {screen === "home" && (
        <Home
          navigate={navigate}
          toast={toast}
          auth={auth}
          startOnboarding={() => setPreAuthOpen(true)}
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
        />
      )}
      {screen === "vote" && <Voting navigate={navigate} toast={toast} />}
      {screen === "leaderboard" && <Leaderboard navigate={navigate} />}
      {screen === "shop" && (
        <Shop navigate={navigate} toast={toast} auth={auth} />
      )}
      {profileOpen && (
        <ProfileModal
          close={() => setProfileOpen(false)}
          auth={auth}
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
          step={!auth.github ? "github" : "placement"}
          onSelectExperience={(experience) => void saveExperience(experience)}
          close={() => setOnboardingOpen(false)}
        />
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
