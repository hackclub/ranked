"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollaborativeEditor } from "./realtime/CollaborativeEditor";
import { StreamVideo } from "./realtime/StreamVideo";
import { useCodeRoom, useRealtimeRoom } from "./realtime/useRealtimeRoom";
import { getYjsProviderForRoom } from "@liveblocks/yjs";

type Screen = "home" | "lobby" | "match" | "vote" | "leaderboard" | "shop";
type Mode = "solo" | "duo";
type Experience = "beginner" | "intermediate" | "expert";
type AuthState = {
  user: { id: string; name: string; email: string; slackId: string | null; verificationStatus: string | null; experience: Experience | null; elo: number; matchesPlayed: number; codingSeconds: number; hBucks: number; avatar: { color: string; eyes: number; mouths: number } } | null;
  github: { login: string; avatarUrl: string | null } | null;
};
type ActiveMatch = { id: string; mode: Mode; durationMinutes: number; theme: string; status: string; startedAt: string; endsAt: string; remainingSeconds: number; team: "blue" | "red" };
type MatchOutcome = { status: string; winningTeam: "blue" | "red" | null; endReason: string | null; forfeitedBy: string | null; forfeitingTeam: "blue" | "red" | null; endedAt: string | null; remainingSeconds: number };
type DisconnectNotice = { userId: string; name: string; team: "blue" | "red"; expiresAt: string; secondsRemaining: number };
type MediaPrefs = { mic: boolean; video: boolean; micDeviceId?: string; videoDeviceId?: string };
type DashboardData = {
  friends: Array<{ id: string; friendshipId: string; name: string; slackId: string | null; status: string; incoming: boolean }>;
  recent: Array<{ id: string; theme: string; status: string; createdAt: string; opponents: Array<{ id: string; name: string }> }>;
  challenges: Array<{ type: string; progress: number; target: number; rewardElo: number; rewardHBucks: number; rewardClaimed: boolean }>;
  voteGate: { required: number; cast: number; available: boolean; due: boolean; deferred: boolean };
};

const COLORS = ["#D891D9", "#497CBF", "#CCD96C", "#D99F6C", "#BF5A5A"];

async function clearBrowserSiteData() {
  window.localStorage.clear();
  window.sessionStorage.clear();

  const cleanup: Array<Promise<unknown>> = [];
  if ("caches" in window) {
    cleanup.push(
      window.caches.keys().then(keys =>
        Promise.all(keys.map(key => window.caches.delete(key))),
      ),
    );
  }
  if ("serviceWorker" in navigator) {
    cleanup.push(
      navigator.serviceWorker.getRegistrations().then(registrations =>
        Promise.all(registrations.map(registration => registration.unregister())),
      ),
    );
  }
  if ("indexedDB" in window && typeof window.indexedDB.databases === "function") {
    cleanup.push(
      window.indexedDB.databases().then(databases =>
        Promise.all(databases.flatMap(database => database.name ? [new Promise<void>(resolve => {
          const deletion = window.indexedDB.deleteDatabase(database.name!);
          deletion.onsuccess = () => resolve();
          deletion.onerror = () => resolve();
          deletion.onblocked = () => resolve();
        })] : [])),
      ),
    );
  }

  document.cookie.split(";").forEach(cookie => {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=; Max-Age=0; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
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

function Icon({ children }: { children: React.ReactNode }) {
  return <span aria-hidden="true" className="icon">{children}</span>;
}

function ScribbleAvatar({ color = COLORS[1], eyes = 2, mouths = 1, size = "lg", label = "Player avatar" }: {
  color?: string; eyes?: number; mouths?: number; size?: "sm" | "md" | "lg"; label?: string;
}) {
  return (
    <div className={`scribble-avatar avatar-${size}`} style={{ "--avatar": color } as React.CSSProperties} role="img" aria-label={label}>
      <div className="scribble-ring ring-one" />
      <div className="scribble-ring ring-two" />
      <div className="avatar-face">
        <div className="eyes">{Array.from({ length: eyes }).map((_, i) => <i key={i} />)}</div>
        <div className="mouths">{Array.from({ length: mouths }).map((_, i) => <b key={i} />)}</div>
      </div>
      <div className="avatar-legs"><i /><i /></div>
    </div>
  );
}

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <button className={`logo ${compact ? "compact" : ""}`} onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })} aria-label="Ranked home">
      <span>HACK CLUB</span><em>ranked</em>
    </button>
  );
}

function ProgressBar({ elo = 1500 }: { elo?: number }) {
  const progress = Math.max(0, Math.min(100, ((elo - 1500) / 1500) * 100));
  return (
    <div className="rank-wrap" aria-label={`Elo rating ${elo}`}>
      <div className="rank-labels"><span>1500</span><strong>{elo} ELO</strong><span>celestial at 3000</span></div>
      <div className="rank-track"><div className="rank-fill" style={{ width: `${progress}%` }} /><i className="rank-dot" style={{ left: `${progress}%` }} /></div>
      <div className="rank-meta"><span>meteor</span><span>{Math.max(0, 3000 - elo)} to celestial</span></div>
    </div>
  );
}

function SiteHeader({ screen, navigate, onProfile, balance, avatar }: { screen: Screen; navigate: (s: Screen) => void; onProfile: () => void; balance: number; avatar?: { color: string; eyes: number; mouths: number } }) {
  return (
    <header className="site-header">
      <nav aria-label="Main navigation">
        <button className={screen === "shop" ? "active" : ""} onClick={() => navigate("shop")}>shop <span className="nav-pill">{balance} Ħ</span></button>
        <button className={screen === "leaderboard" ? "active" : ""} onClick={() => navigate("leaderboard")}>leaderboard</button>
      </nav>
      <Logo />
      <button className="profile-button" onClick={onProfile} aria-label="Open profile and account settings">
        <ScribbleAvatar size="sm" color={avatar?.color} eyes={avatar?.eyes} mouths={avatar?.mouths} />
        <span className="online-dot" />
      </button>
    </header>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="card-title"><span>{children}</span></h2>;
}

function Home({ navigate, toast, auth }: { navigate: (s: Screen) => void; toast: (m: string) => void; auth: AuthState }) {
  const [friendRequests, setFriendRequests] = useState<string[]>([]);
  const [friendName, setFriendName] = useState("");
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);

  useEffect(() => {
    if (!auth.user) return;
    fetch("/api/dashboard").then(response => response.ok ? response.json() : null).then(data => data && setDashboard(data)).catch(() => undefined);
  }, [auth.user]);

  const addFriend = async (id: string, name: string) => {
    if (friendRequests.includes(id)) return toast(`You already nudged @${name}`);
    const response = await fetch("/api/friends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetUserId: id }) });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Could not send that request");
    setFriendRequests(current => [...current, id]);
    toast(`Friend request sent to @${name}`);
  };

  const addSlackFriend = async (event: React.FormEvent) => {
    event.preventDefault();
    const response = await fetch("/api/friends", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slackUsername: friendName }) });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Could not find that Slack user");
    setFriendName(""); toast("Friend request sent");
  };

  const acceptFriend = async (friendshipId: string) => {
    const response = await fetch("/api/friends", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ friendshipId, action: "accept" }) });
    if (!response.ok) return toast("Could not accept that request");
    setDashboard(current => current ? { ...current, friends: current.friends.map(friend => friend.friendshipId === friendshipId ? { ...friend, status: "accepted" } : friend) } : current);
    toast("Friend added");
  };

  return (
    <main className="home-screen screen-pad">
      <ProgressBar elo={auth.user?.elo} />
      <section className="home-grid">
        <aside className="home-left">
          <div className="paper-card friends-card">
            <CardTitle>friends <button aria-label="Add a friend" onClick={() => toast("Connect Hack Club Slack in your profile to find friends")}>＋</button></CardTitle>
            <ul className="people-list">
              {dashboard?.friends.length ? dashboard.friends.map(friend => <li key={friend.id}><span className="mini-face blue">{friend.name[0]}</span><div><strong>{friend.name}</strong><small>{friend.status === "accepted" ? "friend" : friend.incoming ? "request received" : "request sent"}</small></div>{friend.status === "pending" && friend.incoming ? <button onClick={() => void acceptFriend(friend.friendshipId)}>accept</button> : <i className="status" />}</li>) : <li><div><strong>No teammates yet</strong><small>Add someone from a recent match.</small></div></li>}
            </ul>
            <form className="friend-search" onSubmit={event => void addSlackFriend(event)}><input value={friendName} onChange={event => setFriendName(event.target.value)} placeholder="@slack username" required /><button type="submit">add</button></form>
          </div>
          <div className="paper-card interactions-card">
            <CardTitle>recent interactions</CardTitle>
            <ul className="interaction-list">
              {dashboard?.recent.flatMap(match => match.opponents?.map(opponent => ({ ...opponent, theme: match.theme, matchId: match.id })) ?? []).slice(0, 5).map((interaction, index) => (
                <li key={`${interaction.matchId}-${interaction.id}`}>
                  <span className="interaction-avatar" style={{ background: COLORS[index % COLORS.length] }}>{interaction.name[0].toUpperCase()}</span>
                  <div><strong>{interaction.name}</strong><small>{interaction.theme}</small></div>
                  <button className={friendRequests.includes(interaction.id) ? "sent" : ""} onClick={() => void addFriend(interaction.id, interaction.name)} aria-label={`Add ${interaction.name} as a friend`}>{friendRequests.includes(interaction.id) ? "✓" : "+"}</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="hero-zone">
          <div className="elo-sticker">#284 <span>global</span></div>
          <ScribbleAvatar color={auth.user?.avatar.color} eyes={auth.user?.avatar.eyes} mouths={auth.user?.avatar.mouths} label="Your scribble avatar" />
          <div className="hero-copy">
            <p>ready to make something weird?</p>
            <button className="primary-button start-button" onClick={() => auth.user ? navigate("lobby") : window.location.assign("/api/auth/hackclub/start")}>{auth.user ? "find a match" : "sign in to play"} <Icon>↗</Icon></button>
            <div className="queue-note"><i /> {auth.user ? `${auth.user.name} · authenticated` : "Hack Club account required"}</div>
          </div>
        </section>

        <aside className="home-right">
          <div className="paper-card daily-card">
            <div className="burst">★</div><CardTitle>daily challenges</CardTitle><div className="burst right">★</div>
            {(dashboard?.challenges ?? []).map(challenge => <Challenge key={challenge.type}
              label={challenge.type === "play_matches" ? "Play 2 matches" : challenge.type === "code_seconds" ? "Code for 3 hours" : "Add 2 friends"}
              value={`${Math.min(challenge.progress, challenge.target)} / ${challenge.target}`}
              progress={Math.min(100, challenge.progress / challenge.target * 100)}
              reward={challenge.rewardElo ? `+${challenge.rewardElo} ELO` : `+${challenge.rewardHBucks} Ħ`} />)}
            <small className="resets">resets in 08:42:16</small>
          </div>
          <div className="paper-card vote-nudge">
            <div className="vote-icon">◒</div><div><strong>{dashboard?.voteGate.due ? `${dashboard.voteGate.required - dashboard.voteGate.cast} vote due` : dashboard?.voteGate.available ? "community voting" : "no votes waiting"}</strong><span>{dashboard?.voteGate.due ? "Vote to unlock your next match" : dashboard?.voteGate.available ? "Help choose another match winner" : dashboard?.voteGate.deferred ? "You can keep playing until a vote appears" : "Fresh matchups will appear here"}</span></div>
            <button onClick={() => navigate("vote")} disabled={!dashboard?.voteGate.available}>vote now</button>
          </div>
        </aside>
      </section>
    </main>
  );
}

function Challenge({ label, value, progress, reward }: { label: string; value: string; progress: number; reward: string }) {
  return (
    <div className="challenge">
      <div><strong>{label}</strong><span>{value}</span></div>
      <div className="challenge-track"><i style={{ width: `${progress}%` }} /></div>
      <small>{reward}</small>
    </div>
  );
}

function ExperienceModal({ close, select }: { close: () => void; select: (e: Experience) => void }) {
  const levels: { key: Experience; title: string; desc: string; symbol: string }[] = [
    { key: "beginner", title: "Beginner", desc: "Not many websites made — yet.", symbol: "✦" },
    { key: "intermediate", title: "Intermediate", desc: "I know my HTML & CSS basics.", symbol: "✦✦" },
    { key: "expert", title: "Expert", desc: "HTML / CSS / JS is my playground.", symbol: "✦✦✦" },
  ];
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="experience-title">
      <section className="modal experience-modal">
        <button className="close-button" onClick={close} aria-label="Close">×</button>
        <span className="eyebrow">placement 01 / 02</span>
        <h2 id="experience-title">How much have you built?</h2>
        <p>This gives you fair first matches. After a few games, your ELO takes over.</p>
        <div className="level-grid">
          {levels.map(level => <button key={level.key} onClick={() => select(level.key)}><span>{level.symbol}</span><strong>{level.title}</strong><small>{level.desc}</small></button>)}
        </div>
      </section>
    </div>
  );
}

function AvatarCustomizer({ color, setColor, eyes, setEyes, mouths, setMouths }: {
  color: string; setColor: (c: string) => void; eyes: number; setEyes: (n: number) => void; mouths: number; setMouths: (n: number) => void;
}) {
  return (
    <div className="avatar-customizer">
      <span className="eyebrow">your scribble</span>
      <div className="avatar-stage"><ScribbleAvatar color={color} eyes={eyes} mouths={mouths} /></div>
      <div className="customize-row"><span>color</span><div className="swatches">{COLORS.map(c => <button key={c} className={c === color ? "selected" : ""} style={{ background: c }} onClick={() => setColor(c)} aria-label={`Choose ${c}`} />)}</div></div>
      <div className="customize-row"><span>eyes</span><div className="stepper"><button onClick={() => setEyes(Math.max(1, eyes - 1))}>−</button><b>{eyes}</b><button onClick={() => setEyes(Math.min(5, eyes + 1))}>＋</button></div></div>
      <div className="customize-row"><span>mouths</span><div className="stepper"><button onClick={() => setMouths(Math.max(1, mouths - 1))}>−</button><b>{mouths}</b><button onClick={() => setMouths(Math.min(3, mouths + 1))}>＋</button></div></div>
      <button className="shuffle-button" onClick={() => { setColor(COLORS[Math.floor(Math.random() * COLORS.length)]); setEyes(1 + Math.floor(Math.random() * 5)); setMouths(1 + Math.floor(Math.random() * 3)); }}>↻ shuffle me</button>
    </div>
  );
}

function Lobby({ navigate, toast, user, onMatched }: { navigate: (s: Screen) => void; toast: (m: string) => void; user: NonNullable<AuthState["user"]>; onMatched: (match: ActiveMatch, media: MediaPrefs) => void }) {
  const [mode, setMode] = useState<Mode>("duo");
  const [length, setLength] = useState(30);
  const [mic, setMic] = useState(true);
  const [video, setVideo] = useState(true);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [micDeviceId, setMicDeviceId] = useState("");
  const [videoDeviceId, setVideoDeviceId] = useState("");
  const [color, setColor] = useState(COLORS[1]);
  const [eyes, setEyes] = useState(2);
  const [mouths, setMouths] = useState(1);
  const [matching, setMatching] = useState(false);
  const [experienceOpen, setExperienceOpen] = useState(false);
  const [experience, setExperience] = useState<Experience>(user.experience ?? "beginner");

  const acceptQueueResult = useCallback((result: { status?: string; match?: ActiveMatch; error?: string; code?: string }) => {
    if (result.match) return onMatched(result.match, { mic, video, micDeviceId: micDeviceId || undefined, videoDeviceId: videoDeviceId || undefined });
    if (result.code === "vote_required") { setMatching(false); toast(result.error ?? "Vote required"); navigate("vote"); }
  }, [mic, micDeviceId, navigate, onMatched, toast, video, videoDeviceId]);

  useEffect(() => { navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(() => undefined); }, []);

  const ready = async () => {
    setMatching(true);
    await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experience, avatar: { color, eyes, mouths } }) });
    const response = await fetch("/api/matchmaking/queue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, durationMinutes: length, experience }) });
    const result = await response.json();
    if (!response.ok && result.code !== "vote_required") { setMatching(false); toast(result.error ?? "Could not join the queue"); return; }
    acceptQueueResult(result);
  };

  const testSetup = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true, video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true });
      stream.getTracks().forEach(track => track.stop());
      setDevices(await navigator.mediaDevices.enumerateDevices());
      toast("Looks good — your mic and camera are ready");
    } catch { toast("Camera or microphone permission was blocked"); }
  };

  useEffect(() => {
    if (!matching) return;
    const poll = window.setInterval(() => fetch("/api/matchmaking/queue").then(response => response.json()).then(acceptQueueResult).catch(() => undefined), 2000);
    return () => window.clearInterval(poll);
  }, [acceptQueueResult, matching]);

  return (
    <main className="lobby-screen screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="lobby-heading"><span className="eyebrow">ready room</span><h1>Set your match up.</h1><p>We’ll find builders close to your skill. Change anything before you jump in.</p></div>
      <section className="lobby-grid">
        <div className="settings-panel">
          <div className="setting-block">
            <label>team size</label>
            <div className="segmented">
              <button className={mode === "solo" ? "active" : ""} onClick={() => setMode("solo")}><Icon>●</Icon><span>solo<small>1 vs 1</small></span></button>
              <button className={mode === "duo" ? "active" : ""} onClick={() => setMode("duo")}><Icon>●●</Icon><span>duos<small>2 vs 2</small></span></button>
            </div>
          </div>
          <div className="setting-block">
            <label>match length</label>
            <div className="time-options">{[10, 30, 60].map(time => <button key={time} className={length === time ? "active" : ""} onClick={() => setLength(time)}><strong>{time}</strong><small>min</small></button>)}</div>
          </div>
          <div className="setting-block devices-block">
            <label>camera & microphone</label>
            <div className="device-row"><button onClick={() => setMic(!mic)} className={mic ? "on" : ""}><Icon>{mic ? "◉" : "⊘"}</Icon>{mic ? "Mic on" : "Mic off"}</button><select aria-label="Microphone" value={micDeviceId} onChange={event => setMicDeviceId(event.target.value)}><option value="">Default microphone</option>{devices.filter(device => device.kind === "audioinput").map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}</select></div>
            <div className="device-row"><button onClick={() => setVideo(!video)} className={video ? "on" : ""}><Icon>{video ? "▣" : "▢"}</Icon>{video ? "Camera on" : "Camera off"}</button><select aria-label="Camera" value={videoDeviceId} onChange={event => setVideoDeviceId(event.target.value)}><option value="">Default camera</option>{devices.filter(device => device.kind === "videoinput").map((device,index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}</select></div>
            <button className="test-link" onClick={() => void testSetup()}>test my setup ↗</button>
          </div>
          <div className="matchmaking-note"><Icon>◎</Icon><p>Matching by <strong>{experience}</strong> + ELO <b>{user.elo}</b></p><button onClick={() => setExperienceOpen(true)}>change</button></div>
        </div>
        <AvatarCustomizer color={color} setColor={setColor} eyes={eyes} setEyes={setEyes} mouths={mouths} setMouths={setMouths} />
        <div className="ready-column">
          <div className="duo-preview">
            <span className="eyebrow">{mode === "duo" ? "your duo" : "your slot"}</span>
            <div className="player-ready"><ScribbleAvatar color={color} eyes={eyes} mouths={mouths} size="md" /><div><strong>{user.name}</strong><span><i /> ready</span></div></div>
            {mode === "duo" && <div className="player-ready empty"><div className="empty-avatar">?</div><div><strong>matching teammate</strong><span>close to {user.elo} ELO</span></div></div>}
          </div>
          <div className="summary-ticket"><span>{mode === "duo" ? "2 vs 2" : "1 vs 1"}</span><span>{length} minutes</span><span>open theme</span></div>
          <button className="primary-button ready-button" onClick={() => void ready()} disabled={matching}>{matching ? <><i className="spinner" /> finding your match…</> : <>ready up <Icon>↗</Icon></>}</button>
          <small className="ready-fineprint">By joining, you agree to keep it kind and keep it open source.</small>
        </div>
      </section>
      {experienceOpen && <ExperienceModal close={() => setExperienceOpen(false)} select={(e) => { setExperience(e); setExperienceOpen(false); toast(`Placement level set to ${e}`); }} />}
    </main>
  );
}

function VideoTile({ name, team, color, eyes = 2, mouths = 1, muted = false, stream, local = false, audioMuted = false }: { name: string; team: string; color: string; eyes?: number; mouths?: number; muted?: boolean; stream?: MediaStream | null; local?: boolean; audioMuted?: boolean }) {
  return (
    <div className="video-tile" style={{ "--tile": color } as React.CSSProperties}>
      {stream ? <StreamVideo stream={stream} muted={local || audioMuted} label={`${name}'s live video`} /> : <ScribbleAvatar color={color} eyes={eyes} mouths={mouths} size="md" label={`${name}'s camera placeholder`} />}
      <div className="video-label"><span><i />{name}</span><small>{team}</small></div>
      {muted && <span className="muted-badge">mic off</span>}
    </div>
  );
}

function Match({ navigate, toast, auth, match, media }: { navigate: (s: Screen) => void; toast: (m: string) => void; auth: AuthState; match: ActiveMatch; media: MediaPrefs }) {
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
  const [disconnect, setDisconnect] = useState<DisconnectNotice | null>(null);
  const [outcome, setOutcome] = useState<MatchOutcome | null>(null);
  const [repoName, setRepoName] = useState("");
  const [publishState, setPublishState] = useState<{ loading: boolean; error?: string; repositoryUrl?: string; pagesUrl?: string }>({ loading: false });
  const team = match.team;
  const { status, localStream, remotePeers } = useRealtimeRoom(`ranked:call:${match.id}`, mic, video, scope, team, media.micDeviceId, media.videoDeviceId);
  const room = useCodeRoom(`ranked:code:${match.id}:${team}`);

  useEffect(() => {
    if (!room) return;
    const provider = getYjsProviderForRoom(room, { offlineSupport_experimental: true });
    const texts = Object.keys(starterFiles).map(name => ({ name, text: provider.getYDoc().getText(`file:${name}`) }));
    const syncAll = () => setFiles(current => Object.fromEntries(texts.map(({ name, text }) => [name, text.length ? text.toString() : current[name]])));
    const seedAll = (synced: boolean) => {
      if (!synced) return;
      for (const { name, text } of texts) if (!text.length) text.insert(0, starterFiles[name]);
      syncAll();
    };
    for (const { text } of texts) text.observe(syncAll);
    provider.on("sync", seedAll);
    seedAll(provider.synced);
    return () => { for (const { text } of texts) text.unobserve(syncAll); provider.off("sync", seedAll); };
  }, [room]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(s => Math.max(0, s - 1));
      setSyncIn(s => s <= 1 ? 30 : s - 1);
      setDisconnect(current => current ? { ...current, secondsRemaining: Math.max(0, current.secondsRemaining - 1) } : null);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const previewDoc = useMemo(() => {
    const withStyles = files["index.html"].includes("</head>")
      ? files["index.html"].replace("</head>", `<style>${files["styles.css"]}</style></head>`)
      : `<style>${files["styles.css"]}</style>${files["index.html"]}`;
    return withStyles.includes("</body>")
      ? withStyles.replace("</body>", `<script>${files["script.js"]}<\/script></body>`)
      : `${withStyles}<script>${files["script.js"]}<\/script>`;
  }, [files]);
  const previewDocRef = useRef(previewDoc);
  useEffect(() => { previewDocRef.current = previewDoc; }, [previewDoc]);
  const updateCurrentFile = useCallback((value: string) => {
    setFiles(current => ({ ...current, [tab]: value }));
  }, [tab]);

  const publish = useCallback(async () => {
    if (publishState.loading || publishState.repositoryUrl) return;
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === "." || repoName === "..") {
      setPublishState({ loading: false, error: "Use letters, numbers, periods, underscores, or hyphens for the repository name." });
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
        body: JSON.stringify({ matchId: match.id, name: repoName, html: previewDoc, files }),
      });
      const result = await response.json() as { error?: string; repositoryUrl?: string; pagesUrl?: string };
      if (!response.ok || !result.repositoryUrl || !result.pagesUrl) throw new Error(result.error ?? "Publishing failed.");
      setPublishState({ loading: false, repositoryUrl: result.repositoryUrl, pagesUrl: result.pagesUrl });
      toast(`Published ${repoName} — GitHub Pages is building now`);
    } catch (error) {
      setPublishState({ loading: false, error: error instanceof Error ? error.message : "Publishing failed." });
    }
  }, [auth.github, files, match.id, previewDoc, publishState.loading, publishState.repositoryUrl, repoName, toast]);

  const applyLifecycle = useCallback((result: { match?: MatchOutcome | null; disconnect?: DisconnectNotice | null }) => {
    setDisconnect(result.disconnect ?? null);
    if (result.match && Number.isFinite(Number(result.match.remainingSeconds))) {
      setSeconds(Math.max(0, Math.ceil(Number(result.match.remainingSeconds))));
    }
    if (result.match?.status === "completed" && ["forfeit", "disconnect"].includes(result.match.endReason ?? "")) {
      setOutcome(result.match);
      setPublishOpen(false);
      setForfeitOpen(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const heartbeat = async () => {
      try {
        const response = await fetch(`/api/matches/${match.id}/heartbeat`, { method: "POST" });
        if (!response.ok || cancelled) return;
        applyLifecycle(await response.json());
      } catch {}
    };
    void heartbeat();
    const timer = window.setInterval(() => void heartbeat(), 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
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
      const response = await fetch(`/api/matches/${match.id}/forfeit`, { method: "POST" });
      const result = await response.json() as { error?: string; match?: MatchOutcome | null };
      if (!response.ok && result.match?.status !== "completed") throw new Error(result.error ?? "Could not forfeit the match.");
      applyLifecycle(result);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not forfeit the match.");
    } finally {
      setForfeitLoading(false);
    }
  }, [applyLifecycle, forfeitLoading, match.id, outcome, toast]);

  useEffect(() => {
    const sync = async () => {
      await fetch(`/api/matches/${match.id}/snapshot`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ html: previewDocRef.current }) });
      const response = await fetch(`/api/matches/${match.id}/snapshot`);
      if (response.ok) {
        const result = await response.json() as { snapshot?: { html?: string } | null };
        if (result.snapshot?.html) setOpponentSnapshot(result.snapshot.html);
      }
      setSyncIn(30);
    };
    const initial = window.setTimeout(() => void sync(), 1000);
    const interval = window.setInterval(() => void sync(), 30_000);
    return () => { window.clearTimeout(initial); window.clearInterval(interval); };
  }, [match.id]);

  useEffect(() => {
    if (seconds === 0 && !outcome) window.setTimeout(() => setPublishOpen(true), 0);
  }, [outcome, seconds]);

  const disconnectSeconds = disconnect
    ? Math.max(0, disconnect.secondsRemaining)
    : 0;
  const disconnectLabel = disconnect?.team === team
    ? match.mode === "duo" ? "Your teammate disconnected" : "Your connection is unstable"
    : "An opponent disconnected";

  const teammate = remotePeers.find(peer => peer.team === team);
  const opponents = remotePeers.filter(peer => peer.team !== team).slice(0, 2);

  return (
    <main className="match-screen">
      <header className="match-header">
        <button className="match-logo" onClick={() => navigate("home")}>R/</button>
        <div className="theme-tag"><span>THEME</span><strong>{match.theme}</strong></div>
        <div className="timer" aria-label={`${time} remaining`}><span>{time}</span><small>remaining</small></div>
        <div className="match-score"><span><b className="blue-dot" /> your {match.mode === "duo" ? "duo" : "side"} <strong>{auth.user?.elo}</strong></span><i>VS</i><span><b className="red-dot" /> opponents</span></div>
        <div className="match-actions"><button className="forfeit-match" onClick={() => setForfeitOpen(true)} disabled={Boolean(outcome) || forfeitLoading}>forfeit</button><button className="exit-match" onClick={() => setPublishOpen(true)} disabled={seconds > 0 || publishState.loading || Boolean(outcome)}>{publishState.loading ? "publishing…" : seconds > 0 ? "publishes after match" : "publish to GitHub ↗"}</button></div>
      </header>
      {disconnect && !outcome && <div className={`disconnect-banner ${disconnect.team === team ? "danger" : ""}`} role="status"><strong>{disconnectLabel}</strong><span>{disconnectSeconds}s to reconnect before {disconnect.team === team ? "your team forfeits" : "the match ends"}</span></div>}
      <section className="call-strip">
        <div className="call-team"><span className="call-label">YOUR DUO</span><VideoTile name={auth.user?.name ?? "you"} team={`${team} · you`} color={auth.user?.avatar.color ?? COLORS[1]} eyes={auth.user?.avatar.eyes} mouths={auth.user?.avatar.mouths} stream={video ? localStream : null} local muted={!mic} /><VideoTile name={teammate?.name ?? "waiting…"} team={teammate ? "teammate · live" : "waiting for teammate"} color={teammate?.color ?? COLORS[2]} stream={teammate?.video ? teammate.stream : null} muted={teammate ? !teammate.mic : false} /></div>
        <div className="call-team opponents"><span className="call-label">OPPONENTS</span>{[0, 1].map(index => { const peer = opponents[index]; return <VideoTile key={peer?.connectionId ?? index} name={peer?.name ?? "open slot"} team={peer ? `${peer.team} team` : "waiting for builder"} color={peer?.color ?? COLORS[index + 3]} stream={peer?.video ? peer.stream : null} muted={peer ? !peer.mic : false} audioMuted={scope === "team" && peer?.team !== team} />; })}</div>
        <div className="call-controls">
          <button className={mic ? "active" : ""} onClick={() => setMic(!mic)} aria-label="Toggle microphone"><Icon>{mic ? "●" : "○"}</Icon><span>mic</span></button>
          <button className={video ? "active" : ""} onClick={() => setVideo(!video)} aria-label="Toggle camera"><Icon>{video ? "■" : "□"}</Icon><span>camera</span></button>
          <div className="scope-toggle"><button className={scope === "team" ? "active" : ""} onClick={() => setScope("team")}>duo only</button><button className={scope === "everyone" ? "active" : ""} onClick={() => setScope("everyone")}>everyone</button></div>
          <button onClick={() => { void navigator.clipboard.writeText(window.location.href); toast("Room link copied — open it in another browser to join"); }}><Icon>↗</Icon><span>invite</span></button>
        </div>
      </section>
      <section className="workspace">
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="file-tabs">{["index.html", "styles.css", "script.js"].map(file => <button key={file} onClick={() => setTab(file)} className={tab === file ? "active" : ""}><i className={`file-dot ${file.split(".")[1]}`} />{file}{tab === file && <span>×</span>}</button>)}</div>
            <div className="collab-state"><div className="face-stack"><i>{auth.user?.name?.[0] ?? "Y"}</i>{remotePeers.slice(0, 2).map(peer => <i key={peer.connectionId}>{peer.name[0]}</i>)}</div><span>{remotePeers.length + 1} editing</span><b>{status === "connected" ? "synced" : status}</b></div>
          </div>
          <div className="editor-area">
            <aside className="file-rail"><button className="active">▤</button><button>⌕</button><button>⑂</button><span /><button>⚙</button></aside>
            <CollaborativeEditor room={room} file={tab} initialValue={starterFiles[tab]} onChange={updateCurrentFile} />
          </div>
          <footer className="editor-status"><span>main*</span><span>spaces: 2</span><span>utf-8</span><b>Liveblocks · {status}</b></footer>
        </div>
        <aside className="preview-panel">
          <div className="preview-head"><div><span className="eyebrow">YOUR BUILD</span><strong>live preview</strong></div><div className="browser-dots"><i /><i /><i /></div><button onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? "hide" : "expand"} ↗</button></div>
          <iframe title="Your website live preview" srcDoc={previewDoc} sandbox="allow-scripts" />
          <div className="opponent-snapshot">
            <div><span className="eyebrow">OPPONENT SNAPSHOT</span><strong>update in {syncIn}s</strong></div>
            {opponentSnapshot ? <iframe title="Opponent website snapshot" srcDoc={opponentSnapshot} sandbox="allow-scripts" /> : <div className="snapshot-art"><span className="planet-one" /><span className="planet-two" /><b>waiting for<br />their first sync</b></div>}
            <button onClick={() => toast("Snapshots sync automatically every 30 seconds")}>live sync <small>server verified</small></button>
          </div>
        </aside>
      </section>
      {previewOpen && <div className="preview-modal modal-backdrop" onClick={() => setPreviewOpen(false)}><div className="expanded-preview" onClick={e => e.stopPropagation()}><button onClick={() => setPreviewOpen(false)}>×</button><iframe title="Expanded live preview" srcDoc={previewDoc} sandbox="allow-scripts" /></div></div>}
      {(publishOpen || publishState.repositoryUrl) && !outcome && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="publish-title"><section className="modal publish-modal"><span className="eyebrow">match complete · your GitHub copy</span><h2 id="publish-title">{publishState.repositoryUrl ? "Your build is open source." : "Name your repository."}</h2>{publishState.repositoryUrl ? <><p>Every player publishes the finished build to their own account. Voting opens after everyone has finished publishing.</p><div className="publish-links"><a href={publishState.repositoryUrl} target="_blank" rel="noreferrer">open repository ↗</a><a href={publishState.pagesUrl} target="_blank" rel="noreferrer">open live website ↗</a></div><button className="primary-button" onClick={() => navigate("home")}>return home</button></> : <><p>Choose the exact public repository name to create under {auth.github ? <strong>@{auth.github.login}</strong> : "your GitHub account"}.</p><label className="repo-name-field"><span>github.com/{auth.github?.login ?? "you"}/</span><input value={repoName} onChange={event => { setRepoName(event.target.value); if (publishState.error) setPublishState({ loading: false }); }} placeholder="my-ranked-build" autoFocus maxLength={100} pattern="[A-Za-z0-9._-]+" required /></label>{publishState.error && <p className="publish-error">{publishState.error}</p>}{auth.github ? <button className="primary-button" onClick={() => void publish()} disabled={publishState.loading || !repoName}>{publishState.loading ? "creating repository…" : "publish repo & Pages ↗"}</button> : <a className="primary-button github-connect" href="/api/auth/github/start">connect GitHub ↗</a>}<small>The repository will be public and include the finished site plus the original HTML, CSS, and JavaScript files.</small></>}</section></div>}
      {forfeitOpen && !outcome && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="forfeit-title"><section className="modal publish-modal forfeit-modal"><span className="eyebrow">leave this match</span><h2 id="forfeit-title">Forfeit the match?</h2><p>This ends the match immediately. The other team wins and ELO is updated.</p><div className="forfeit-actions"><button onClick={() => setForfeitOpen(false)} disabled={forfeitLoading}>keep coding</button><button className="danger-button" onClick={() => void forfeit()} disabled={forfeitLoading}>{forfeitLoading ? "closing match…" : "yes, forfeit"}</button></div></section></div>}
      {outcome && <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="outcome-title"><section className="modal publish-modal outcome-modal"><span className="eyebrow">match closed · {outcome.endReason}</span><h2 id="outcome-title">{outcome.winningTeam === team ? "You win by forfeit." : "Your team forfeited."}</h2><p>{outcome.endReason === "disconnect" ? "A player did not reconnect during the 10-second grace period." : "A player chose to end the match early."} ELO has been updated for both teams.</p><button className="primary-button" onClick={() => navigate("home")}>return home</button></section></div>}
    </main>
  );
}

function Leaderboard({ navigate }: { navigate: (s: Screen) => void }) {
  const [board, setBoard] = useState<"elo" | "hours">("elo");
  const [rows, setRows] = useState<Array<{ id: string; name: string; score: number | string; matchesPlayed: number }>>([]);
  useEffect(() => { fetch(`/api/leaderboard?type=${board}`).then(response => response.json()).then(result => setRows(result.players ?? [])).catch(() => setRows([])); }, [board]);
  return (
    <main className="subpage screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="subpage-head"><span className="eyebrow">global rankings</span><h1>Builders on a roll.</h1><p>Win community votes, climb the ladder, and keep shipping strange little websites.</p></div>
      <div className="board-toggle"><button className={board === "elo" ? "active" : ""} onClick={() => setBoard("elo")}>highest ELO</button><button className={board === "hours" ? "active" : ""} onClick={() => setBoard("hours")}>most hours</button></div>
      <section className="leader-card"><div className="leader-row leader-head"><span>rank</span><span>builder</span><span>{board === "elo" ? "ELO" : "hours"}</span><span>matches</span></div>{rows.map((row, index) => <div className="leader-row" key={row.id}><strong>#{index + 1}</strong><span><i style={{ background: COLORS[index % COLORS.length] }}>{row.name[0].toUpperCase()}</i><b>{row.name}</b></span><strong>{row.score}</strong><span>{row.matchesPlayed}</span></div>)}</section>
    </main>
  );
}

const products = [
  ["stickers", "Ranked sticker pack", "Cover absolutely everything.", "100", "✦", COLORS[0]],
  ["flipper", "Flipper Zero", "For curious hardware hackers.", "4500", "⌁", COLORS[4]],
  ["ipad", "iPad", "Sketch the next strange thing.", "9000", "▣", COLORS[2]],
  ["macbook", "MacBook Air", "A lot of hours. Very worth it.", "18000", "⌘", COLORS[1]],
];

function Shop({ navigate, toast, auth }: { navigate: (s: Screen) => void; toast: (m: string) => void; auth: AuthState }) {
  const [selected, setSelected] = useState<(typeof products)[number] | null>(null);
  const [balance, setBalance] = useState(auth.user?.hBucks ?? 0);
  useEffect(() => { if (auth.user) fetch("/api/shop/orders").then(r => r.json()).then(data => setBalance(data.balance ?? 0)).catch(() => undefined); }, [auth.user]);
  const redeem = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected) return;
    const form = new FormData(event.currentTarget);
    const shipping = Object.fromEntries(form.entries());
    const response = await fetch("/api/shop/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ itemId: selected[0], shipping }) });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Redemption failed");
    setBalance(result.balance); setSelected(null); toast("Redemption submitted for approval");
  };
  return (
    <main className="subpage shop-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="subpage-head"><span className="eyebrow">the H-Bucks shop</span><h1>Code time pays.</h1><p>Earn 10 H-Bucks for every focused hour. Save up for real tech, stickers, and hacker gear.</p><div className="balance">your balance <strong>{balance} Ħ</strong></div></div>
      <section className="product-grid">{products.map(product => { const [id,name,desc,price,symbol,color] = product; return <article key={id} className="product-card" style={{ "--product": color } as React.CSSProperties}><div className="product-art">{symbol}</div><span className="eyebrow">ships worldwide</span><h2>{name}</h2><p>{desc}</p><div><strong>{Number(price).toLocaleString()} Ħ</strong><button onClick={() => Number(price) > balance ? toast(`Keep building — you need more H-Bucks for ${name}`) : setSelected(product)}>redeem</button></div></article>; })}</section>
      {selected && <div className="modal-backdrop"><form className="modal shipping-modal" onSubmit={event => void redeem(event)}><button type="button" className="close-button" onClick={() => setSelected(null)}>×</button><span className="eyebrow">secure redemption</span><h2>Ship your {selected[1]}</h2><input name="name" placeholder="Full name" required /><input name="address1" placeholder="Address" required /><input name="address2" placeholder="Apartment / suite" /><input name="city" placeholder="City" required /><input name="region" placeholder="State / region" required /><input name="postalCode" placeholder="Postal code" required /><input name="country" placeholder="Country" required /><button className="primary-button" type="submit">redeem {Number(selected[3]).toLocaleString()} Ħ</button></form></div>}
    </main>
  );
}

function Voting({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  const [voted, setVoted] = useState<"blue" | "red" | null>(null);
  const [match, setMatch] = useState<{ id: string; theme: string; durationMinutes: number; sites: Record<"blue" | "red", { pagesUrl: string; repositoryUrl: string }> } | null>(null);
  useEffect(() => { fetch("/api/votes").then(r => r.json()).then(data => setMatch(data.match ?? null)).catch(() => undefined); }, []);
  const vote = async (choice: "blue" | "red") => {
    if (!match) return;
    const response = await fetch("/api/votes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ matchId: match.id, choice }) });
    const result = await response.json();
    if (!response.ok) return toast(result.error ?? "Vote failed");
    setVoted(choice); toast("Vote counted — your next match is unlocked");
  };
  return (
    <main className="vote-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="vote-heading"><span className="eyebrow">community vote{match ? ` · theme: ${match.theme}` : ""}</span><h1>{match ? "Which build hits harder?" : "You’re caught up."}</h1><p>{match ? "Judge the finished site, not the player. Open both, explore, then cast one vote." : "There are no eligible finished matches waiting for your vote right now."}</p></div>
      {match && <>
      <section className="vote-grid">
        <article className={voted === "blue" ? "chosen" : ""}><div className="vote-site"><iframe title="Build A" src={match.sites.blue.pagesUrl} sandbox="allow-scripts allow-same-origin" /></div><footer><div><span>BUILD A</span><small>anonymous · {match.durationMinutes} min · <a href={match.sites.blue.repositoryUrl} target="_blank" rel="noreferrer">source ↗</a></small></div><button onClick={() => void vote("blue")}>{voted === "blue" ? "your vote ✓" : "vote for this"}</button></footer></article>
        <div className="versus">VS</div>
        <article className={voted === "red" ? "chosen" : ""}><div className="vote-site"><iframe title="Build B" src={match.sites.red.pagesUrl} sandbox="allow-scripts allow-same-origin" /></div><footer><div><span>BUILD B</span><small>anonymous · {match.durationMinutes} min · <a href={match.sites.red.repositoryUrl} target="_blank" rel="noreferrer">source ↗</a></small></div><button onClick={() => void vote("red")}>{voted === "red" ? "your vote ✓" : "vote for this"}</button></footer></article>
      </section>
      {voted && <div className="vote-thanks"><strong>nice pick.</strong><span>Results reveal when the vote closes. Both builds will be open-sourced on GitHub.</span><button onClick={() => navigate("lobby")}>play another ↗</button></div>}
      </>}
    </main>
  );
}

function ProfileModal({ close, auth, logout, logoutLoading }: { close: () => void; auth: AuthState; logout: () => void; logoutLoading: boolean }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <section className="modal profile-modal">
        <button className="close-button" onClick={close}>×</button>
        <ScribbleAvatar color={auth.user?.avatar.color} eyes={auth.user?.avatar.eyes} mouths={auth.user?.avatar.mouths} size="md" />
        <div><span className="eyebrow">your account</span><h2 id="profile-title">{auth.user?.name ?? "Guest builder"}</h2><p>{auth.user ? `${auth.user.email} · ${auth.user.elo} ELO · ${Math.round(auth.user.codingSeconds / 360) / 10}h` : "Sign in to join matches"}</p></div>
        <div className="account-links">
          <a href="/api/auth/hackclub/start">✦ Hack Club Auth <span>{auth.user ? `connected${auth.user.slackId ? ` · ${auth.user.slackId}` : ""}` : "connect ↗"}</span></a>
          <a href="/api/auth/github/start">⌘ GitHub <span>{auth.github ? `@${auth.github.login}` : "connect ↗"}</span></a>
        </div>
        <small>Completed builds are published open source to GitHub and deployed to GitHub Pages.</small>
        {auth.user && <div className="logout-form"><button type="button" onClick={logout} disabled={logoutLoading}>{logoutLoading ? "clearing site data…" : "log out & clear site data"}</button></div>}
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
  const [mediaPrefs, setMediaPrefs] = useState<MediaPrefs>({ mic: true, video: true });
  const [logoutLoading, setLogoutLoading] = useState(false);

  const toast = useCallback((message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 2600);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { credentials: "include" })
      .then(response => response.json())
      .then(async (next: AuthState) => {
        setAuth(next);
        setOnboardingOpen(Boolean(next.user && !next.user.experience));
        if (next.user) {
          const queue = await fetch("/api/matchmaking/queue").then(response => response.json()).catch(() => null);
          if (queue?.match) { setActiveMatch(queue.match); setScreen("match"); }
        }
      })
      .catch(() => setAuth({ user: null, github: null }));
    const params = new URLSearchParams(window.location.search);
    if (params.get("auth") === "connected") window.setTimeout(() => toast("Hack Club account connected"), 0);
    if (params.get("github") === "connected") window.setTimeout(() => toast("GitHub connected — publishing is ready"), 0);
    if (params.get("auth") === "failed" || params.get("github") === "failed") window.setTimeout(() => toast("Connection failed — check your OAuth settings"), 0);
    if (["auth", "github"].some(key => params.has(key))) window.history.replaceState({}, "", window.location.pathname);
  }, [toast]);

  const navigate = (next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveExperience = async (experience: Experience) => {
    const response = await fetch("/api/profile", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ experience }) });
    if (!response.ok) return toast("Could not save your placement level");
    setAuth(current => current.user ? { ...current, user: { ...current.user, experience } } : current);
    setOnboardingOpen(false);
    toast(`Placement level set to ${experience}`);
  };

  const onMatched = useCallback((match: ActiveMatch, media: MediaPrefs = { mic: true, video: true }) => { setMediaPrefs(media); setActiveMatch(match); setScreen("match"); window.scrollTo({ top: 0 }); }, []);

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
      toast("Could not log out — please try again");
    }
  }, [logoutLoading, toast]);

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen !== "match" && <SiteHeader screen={screen} navigate={navigate} onProfile={() => setProfileOpen(true)} balance={auth.user?.hBucks ?? 0} avatar={auth.user?.avatar} />}
      {screen === "home" && <Home navigate={navigate} toast={toast} auth={auth} />}
      {screen === "lobby" && auth.user && <Lobby navigate={navigate} toast={toast} user={auth.user} onMatched={onMatched} />}
      {screen === "lobby" && !auth.user && <Home navigate={navigate} toast={toast} auth={auth} />}
      {screen === "match" && activeMatch && <Match navigate={navigate} toast={toast} auth={auth} match={activeMatch} media={mediaPrefs} />}
      {screen === "match" && !activeMatch && <Home navigate={navigate} toast={toast} auth={auth} />}
      {screen === "vote" && <Voting navigate={navigate} toast={toast} />}
      {screen === "leaderboard" && <Leaderboard navigate={navigate} />}
      {screen === "shop" && <Shop navigate={navigate} toast={toast} auth={auth} />}
      {profileOpen && <ProfileModal close={() => setProfileOpen(false)} auth={auth} logout={() => void logout()} logoutLoading={logoutLoading} />}
      {onboardingOpen && <ExperienceModal close={() => setOnboardingOpen(false)} select={experience => void saveExperience(experience)} />}
      <div className={`toast ${toastMessage ? "show" : ""}`} role="status">{toastMessage}<span>✦</span></div>
    </div>
  );
}
