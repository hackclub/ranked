"use client";

import dynamic from "next/dynamic";
import { useEffect, useMemo, useState } from "react";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), {
  ssr: false,
  loading: () => <div className="editor-loading">Warming up your editor…</div>,
});

type Screen = "home" | "lobby" | "match" | "vote" | "leaderboard" | "shop";
type Mode = "solo" | "duo";
type Experience = "beginner" | "intermediate" | "expert";

const COLORS = ["#D891D9", "#497CBF", "#CCD96C", "#D99F6C", "#BF5A5A"];

const starterCode = `<!doctype html>
<html>
  <head>
    <style>
      body { margin: 0; font-family: system-ui; background: #08131f; color: #fff; }
      main { min-height: 100vh; display: grid; place-items: center; overflow: hidden; }
      .planet { width: 220px; aspect-ratio: 1; border-radius: 50%; background: #D891D9;
        box-shadow: 0 0 0 32px #497CBF22, 0 0 90px #D891D988; display: grid; place-items: center; }
      h1 { font-size: 36px; transform: rotate(-4deg); }
    </style>
  </head>
  <body>
    <main><div class="planet"><h1>hello, orbit!</h1></div></main>
  </body>
</html>`;

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

function ProgressBar() {
  return (
    <div className="rank-wrap" aria-label="Elo progress: 1760, next rank at 1800">
      <div className="rank-labels"><span>1500</span><strong>1760 ELO</strong><span>celestial at 3000</span></div>
      <div className="rank-track"><div className="rank-fill" /><i className="rank-dot" /></div>
      <div className="rank-meta"><span>meteor</span><span>40 to orbit</span></div>
    </div>
  );
}

function SiteHeader({ screen, navigate, onProfile }: { screen: Screen; navigate: (s: Screen) => void; onProfile: () => void }) {
  return (
    <header className="site-header">
      <nav aria-label="Main navigation">
        <button className={screen === "shop" ? "active" : ""} onClick={() => navigate("shop")}>shop <span className="nav-pill">240 Ħ</span></button>
        <button className={screen === "leaderboard" ? "active" : ""} onClick={() => navigate("leaderboard")}>leaderboard</button>
      </nav>
      <Logo />
      <button className="profile-button" onClick={onProfile} aria-label="Open profile and account settings">
        <ScribbleAvatar size="sm" color={COLORS[1]} />
        <span className="online-dot" />
      </button>
    </header>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="card-title"><span>{children}</span></h2>;
}

function Home({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  const [friendRequests, setFriendRequests] = useState<string[]>([]);
  const interactions = [
    ["leo", "solar system", "2h ago", "#D99F6C"],
    ["ducc", "building blocks", "yesterday", "#497CBF"],
    ["willbuilds", "countdown", "2d ago", "#CCD96C"],
  ];

  const addFriend = (name: string) => {
    if (!friendRequests.includes(name)) setFriendRequests([...friendRequests, name]);
    toast(friendRequests.includes(name) ? `You already nudged @${name}` : `Friend request sent to @${name}`);
  };

  return (
    <main className="home-screen screen-pad">
      <ProgressBar />
      <section className="home-grid">
        <aside className="home-left">
          <div className="paper-card friends-card">
            <CardTitle>friends <button aria-label="Add a friend" onClick={() => toast("Connect Hack Club Slack in your profile to find friends")}>＋</button></CardTitle>
            <ul className="people-list">
              <li><span className="mini-face blue">M</span><div><strong>meghana</strong><small>in a match</small></div><i className="status playing" /></li>
              <li><span className="mini-face orange">M</span><div><strong>mihi</strong><small>online now</small></div><i className="status" /></li>
              <li><span className="mini-face green">S</span><div><strong>samliu</strong><small>1 day ago</small></div></li>
            </ul>
          </div>
          <div className="paper-card interactions-card">
            <CardTitle>recent interactions</CardTitle>
            <ul className="interaction-list">
              {interactions.map(([name, theme, when, color]) => (
                <li key={name}>
                  <span className="interaction-avatar" style={{ background: color }}>{name[0].toUpperCase()}</span>
                  <div><strong>{name}</strong><small>{theme} · {when}</small></div>
                  <button className={friendRequests.includes(name) ? "sent" : ""} onClick={() => addFriend(name)} aria-label={`Add ${name} as a friend`}>{friendRequests.includes(name) ? "✓" : "+"}</button>
                </li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="hero-zone">
          <div className="elo-sticker">#284 <span>global</span></div>
          <ScribbleAvatar color={COLORS[1]} eyes={2} mouths={1} label="Your blue scribble avatar" />
          <div className="hero-copy">
            <p>ready to make something weird?</p>
            <button className="primary-button start-button" onClick={() => navigate("lobby")}>find a match <Icon>↗</Icon></button>
            <div className="queue-note"><i /> 48 builders online · ~12 sec queue</div>
          </div>
        </section>

        <aside className="home-right">
          <div className="paper-card daily-card">
            <div className="burst">★</div><CardTitle>daily challenges</CardTitle><div className="burst right">★</div>
            <Challenge label="Play 2 matches" value="1 / 2" progress={50} reward="+25 ELO" />
            <Challenge label="Code for 3 hours" value="2h 12m" progress={73} reward="+30 Ħ" />
            <Challenge label="Invite 2 friends" value="0 / 2" progress={0} reward="+40 ELO" />
            <small className="resets">resets in 08:42:16</small>
          </div>
          <div className="paper-card vote-nudge">
            <div className="vote-icon">◒</div><div><strong>1 vote due</strong><span>Vote to unlock your next match</span></div>
            <button onClick={() => navigate("vote")}>vote now</button>
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

function Lobby({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  const [mode, setMode] = useState<Mode>("duo");
  const [length, setLength] = useState(30);
  const [mic, setMic] = useState(true);
  const [video, setVideo] = useState(true);
  const [color, setColor] = useState(COLORS[1]);
  const [eyes, setEyes] = useState(2);
  const [mouths, setMouths] = useState(1);
  const [matching, setMatching] = useState(false);
  const [experienceOpen, setExperienceOpen] = useState(false);
  const [experience, setExperience] = useState<Experience>("intermediate");

  const ready = () => {
    setMatching(true);
    setTimeout(() => navigate("match"), 1650);
  };

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
            <div className="device-row"><button onClick={() => setMic(!mic)} className={mic ? "on" : ""}><Icon>{mic ? "◉" : "⊘"}</Icon>{mic ? "Mic on" : "Mic off"}</button><select aria-label="Microphone"><option>MacBook Microphone</option><option>External Microphone</option></select></div>
            <div className="device-row"><button onClick={() => setVideo(!video)} className={video ? "on" : ""}><Icon>{video ? "▣" : "▢"}</Icon>{video ? "Camera on" : "Camera off"}</button><select aria-label="Camera"><option>FaceTime HD Camera</option><option>OBS Virtual Camera</option></select></div>
            <button className="test-link" onClick={() => toast("Looks good — your mic and camera are ready")}>test my setup ↗</button>
          </div>
          <div className="matchmaking-note"><Icon>◎</Icon><p>Matching by <strong>{experience}</strong> + ELO <b>1760</b></p><button onClick={() => setExperienceOpen(true)}>change</button></div>
        </div>
        <AvatarCustomizer color={color} setColor={setColor} eyes={eyes} setEyes={setEyes} mouths={mouths} setMouths={setMouths} />
        <div className="ready-column">
          <div className="duo-preview">
            <span className="eyebrow">{mode === "duo" ? "your duo" : "your slot"}</span>
            <div className="player-ready"><ScribbleAvatar color={color} eyes={eyes} mouths={mouths} size="md" /><div><strong>@mihi</strong><span><i /> ready</span></div></div>
            {mode === "duo" && <div className="player-ready empty"><div className="empty-avatar">?</div><div><strong>matching teammate</strong><span>close to 1760 ELO</span></div></div>}
          </div>
          <div className="summary-ticket"><span>{mode === "duo" ? "2 vs 2" : "1 vs 1"}</span><span>{length} minutes</span><span>open theme</span></div>
          <button className="primary-button ready-button" onClick={ready} disabled={matching}>{matching ? <><i className="spinner" /> finding your match…</> : <>ready up <Icon>↗</Icon></>}</button>
          <small className="ready-fineprint">By joining, you agree to keep it kind and keep it open source.</small>
        </div>
      </section>
      {experienceOpen && <ExperienceModal close={() => setExperienceOpen(false)} select={(e) => { setExperience(e); setExperienceOpen(false); toast(`Placement level set to ${e}`); }} />}
    </main>
  );
}

function VideoTile({ name, team, color, muted = false }: { name: string; team: string; color: string; muted?: boolean }) {
  return (
    <div className="video-tile" style={{ "--tile": color } as React.CSSProperties}>
      <ScribbleAvatar color={color} eyes={name === "aisha" ? 3 : 2} mouths={1} size="md" label={`${name}'s video placeholder`} />
      <div className="video-label"><span><i />{name}</span><small>{team}</small></div>
      {muted && <span className="muted-badge">mic off</span>}
    </div>
  );
}

function Match({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  const [seconds, setSeconds] = useState(29 * 60 + 14);
  const [code, setCode] = useState(starterCode);
  const [tab, setTab] = useState("index.html");
  const [mic, setMic] = useState(true);
  const [video, setVideo] = useState(true);
  const [scope, setScope] = useState<"team" | "everyone">("team");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [syncIn, setSyncIn] = useState(18);

  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(s => Math.max(0, s - 1));
      setSyncIn(s => s <= 1 ? 30 : s - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const time = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const previewDoc = useMemo(() => code, [code]);

  return (
    <main className="match-screen">
      <header className="match-header">
        <button className="match-logo" onClick={() => navigate("home")}>R/</button>
        <div className="theme-tag"><span>THEME</span><strong>tiny universe</strong></div>
        <div className="timer" aria-label={`${time} remaining`}><span>{time}</span><small>remaining</small></div>
        <div className="match-score"><span><b className="blue-dot" /> your duo <strong>1760</strong></span><i>VS</i><span><b className="red-dot" /> orbiters <strong>1728</strong></span></div>
        <button className="exit-match" onClick={() => navigate("vote")}>finish demo ↗</button>
      </header>
      <section className="call-strip">
        <div className="call-team"><span className="call-label">YOUR DUO</span><VideoTile name="you" team="1760 ELO" color={COLORS[1]} /><VideoTile name="sacha" team="1734 ELO" color={COLORS[2]} /></div>
        <div className="call-team opponents"><span className="call-label">OPPONENTS</span><VideoTile name="aisha" team="1728 ELO" color={COLORS[3]} muted /><VideoTile name="nico" team="1771 ELO" color={COLORS[4]} /></div>
        <div className="call-controls">
          <button className={mic ? "active" : ""} onClick={() => setMic(!mic)} aria-label="Toggle microphone"><Icon>{mic ? "●" : "○"}</Icon><span>mic</span></button>
          <button className={video ? "active" : ""} onClick={() => setVideo(!video)} aria-label="Toggle camera"><Icon>{video ? "■" : "□"}</Icon><span>camera</span></button>
          <div className="scope-toggle"><button className={scope === "team" ? "active" : ""} onClick={() => setScope("team")}>duo only</button><button className={scope === "everyone" ? "active" : ""} onClick={() => setScope("everyone")}>everyone</button></div>
          <button onClick={() => toast("Chat opened — say something kind") }><Icon>✦</Icon><span>chat</span></button>
        </div>
      </section>
      <section className="workspace">
        <div className="editor-shell">
          <div className="editor-toolbar">
            <div className="file-tabs">{["index.html", "styles.css", "script.js"].map(file => <button key={file} onClick={() => setTab(file)} className={tab === file ? "active" : ""}><i className={`file-dot ${file.split(".")[1]}`} />{file}{tab === file && <span>×</span>}</button>)}</div>
            <div className="collab-state"><div className="face-stack"><i>S</i><i>Y</i></div><span>both editing</span><b>synced</b></div>
          </div>
          <div className="editor-area">
            <aside className="file-rail"><button className="active">▤</button><button>⌕</button><button>⑂</button><span /><button>⚙</button></aside>
            <MonacoEditor
              height="100%"
              language={tab.endsWith("css") ? "css" : tab.endsWith("js") ? "javascript" : "html"}
              value={code}
              onChange={(value) => setCode(value ?? "")}
              theme="vs-dark"
              options={{ minimap: { enabled: false }, fontSize: 14, fontFamily: "var(--font-geist-mono)", padding: { top: 16 }, lineNumbersMinChars: 3, scrollBeyondLastLine: false, wordWrap: "on", tabSize: 2 }}
            />
            <div className="remote-cursor"><span>sacha</span></div>
          </div>
          <footer className="editor-status"><span>main*</span><span>spaces: 2</span><span>utf-8</span><b>Live Share · connected</b></footer>
        </div>
        <aside className="preview-panel">
          <div className="preview-head"><div><span className="eyebrow">YOUR BUILD</span><strong>live preview</strong></div><div className="browser-dots"><i /><i /><i /></div><button onClick={() => setPreviewOpen(!previewOpen)}>{previewOpen ? "hide" : "expand"} ↗</button></div>
          <iframe title="Your website live preview" srcDoc={previewDoc} sandbox="allow-scripts" />
          <div className="opponent-snapshot">
            <div><span className="eyebrow">OPPONENT SNAPSHOT</span><strong>update in {syncIn}s</strong></div>
            <div className="snapshot-art"><span className="planet-one" /><span className="planet-two" /><b>lost in<br />the void</b></div>
            <button onClick={() => toast("Snapshot refreshed — next peek in 30 seconds")}>peek now <small>(1 left)</small></button>
          </div>
        </aside>
      </section>
      {previewOpen && <div className="preview-modal modal-backdrop" onClick={() => setPreviewOpen(false)}><div className="expanded-preview" onClick={e => e.stopPropagation()}><button onClick={() => setPreviewOpen(false)}>×</button><iframe title="Expanded live preview" srcDoc={previewDoc} sandbox="allow-scripts" /></div></div>}
    </main>
  );
}

const leaders = [
  ["1", "scrapbook", "2,912", "86h", COLORS[0]],
  ["2", "aisha", "2,847", "71h", COLORS[3]],
  ["3", "willbuilds", "2,803", "93h", COLORS[2]],
  ["284", "mihi (you)", "1,760", "24h", COLORS[1]],
  ["285", "sacha", "1,734", "31h", COLORS[4]],
];

function Leaderboard({ navigate }: { navigate: (s: Screen) => void }) {
  const [board, setBoard] = useState<"elo" | "hours">("elo");
  const rows = board === "elo" ? leaders : [...leaders].sort((a, b) => parseInt(b[3]) - parseInt(a[3]));
  return (
    <main className="subpage screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="subpage-head"><span className="eyebrow">global rankings</span><h1>Builders on a roll.</h1><p>Win community votes, climb the ladder, and keep shipping strange little websites.</p></div>
      <div className="board-toggle"><button className={board === "elo" ? "active" : ""} onClick={() => setBoard("elo")}>highest ELO</button><button className={board === "hours" ? "active" : ""} onClick={() => setBoard("hours")}>most hours</button></div>
      <section className="leader-card"><div className="leader-row leader-head"><span>rank</span><span>builder</span><span>ELO</span><span>hours</span></div>{rows.map(row => <div className={`leader-row ${row[1].includes("you") ? "you" : ""}`} key={row[1]}><strong>#{row[0]}</strong><span><i style={{ background: row[4] }}>{row[1][0].toUpperCase()}</i><b>{row[1]}</b></span><strong>{row[2]}</strong><span>{row[3]}</span></div>)}</section>
    </main>
  );
}

const products = [
  ["Sticker bomb", "Cover absolutely everything.", "80", "✦", COLORS[0]],
  ["Flipper Zero", "For curious hardware hackers.", "7,500", "⌁", COLORS[4]],
  ["iPad mini", "Sketch the next strange thing.", "12,000", "▣", COLORS[2]],
  ["MacBook Air", "A lot of hours. Very worth it.", "30,000", "⌘", COLORS[1]],
];

function Shop({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  return (
    <main className="subpage shop-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="subpage-head"><span className="eyebrow">the H-Bucks shop</span><h1>Code time pays.</h1><p>Earn 10 H-Bucks for every focused hour. Save up for real tech, stickers, and hacker gear.</p><div className="balance">your balance <strong>240 Ħ</strong></div></div>
      <section className="product-grid">{products.map(([name, desc, price, symbol, color]) => <article key={name} className="product-card" style={{ "--product": color } as React.CSSProperties}><div className="product-art">{symbol}</div><span className="eyebrow">ships worldwide</span><h2>{name}</h2><p>{desc}</p><div><strong>{price} Ħ</strong><button onClick={() => toast(parseInt(price.replace(",", "")) > 240 ? `Keep building — you need more H-Bucks for ${name}` : `${name} added to your cart`)}>save item</button></div></article>)}</section>
    </main>
  );
}

function Voting({ navigate, toast }: { navigate: (s: Screen) => void; toast: (m: string) => void }) {
  const [voted, setVoted] = useState<"left" | "right" | null>(null);
  const vote = (side: "left" | "right") => { setVoted(side); toast("Vote counted — your next match is unlocked"); };
  return (
    <main className="vote-page screen-pad">
      <button className="back-button" onClick={() => navigate("home")}>← back to base</button>
      <div className="vote-heading"><span className="eyebrow">community vote · theme: tiny universe</span><h1>Which build hits harder?</h1><p>Judge the finished site, not the player. Open both, explore, then cast one vote.</p></div>
      <section className="vote-grid">
        <article className={voted === "left" ? "chosen" : ""}><div className="vote-site cosmic"><span className="sun" /><span className="orbit" /><h2>field notes<br />from mars</h2><button>explore the log ↗</button></div><footer><div><span>BUILD A</span><small>anonymous · 30 min</small></div><button onClick={() => vote("left")}>{voted === "left" ? "your vote ✓" : "vote for this"}</button></footer></article>
        <div className="versus">VS</div>
        <article className={voted === "right" ? "chosen" : ""}><div className="vote-site void"><span className="planet-one" /><span className="planet-two" /><h2>lost in<br />the void</h2><button>send a signal ↗</button></div><footer><div><span>BUILD B</span><small>anonymous · 30 min</small></div><button onClick={() => vote("right")}>{voted === "right" ? "your vote ✓" : "vote for this"}</button></footer></article>
      </section>
      {voted && <div className="vote-thanks"><strong>nice pick.</strong><span>Results reveal when the vote closes. Both builds will be open-sourced on GitHub.</span><button onClick={() => navigate("lobby")}>play another ↗</button></div>}
    </main>
  );
}

function ProfileModal({ close, toast }: { close: () => void; toast: (m: string) => void }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <section className="modal profile-modal">
        <button className="close-button" onClick={close}>×</button>
        <ScribbleAvatar color={COLORS[1]} size="md" />
        <div><span className="eyebrow">your account</span><h2 id="profile-title">@mihi</h2><p>1760 ELO · 24h 18m coded</p></div>
        <div className="account-links"><button onClick={() => toast("Hack Club Slack connected")}>✦ Hack Club Auth <span>connected</span></button><button onClick={() => toast("GitHub connected — builds publish to @mihi")}>⌘ GitHub <span>@mihi</span></button></div>
        <small>Completed builds are published open source to GitHub and deployed to GitHub Pages.</small>
      </section>
    </div>
  );
}

export default function RankedApp() {
  const [screen, setScreen] = useState<Screen>("home");
  const [toastMessage, setToastMessage] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);

  const toast = (message: string) => {
    setToastMessage(message);
    window.setTimeout(() => setToastMessage(""), 2600);
  };

  const navigate = (next: Screen) => {
    setScreen(next);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  return (
    <div className={`app-shell screen-${screen}`}>
      {screen !== "match" && <SiteHeader screen={screen} navigate={navigate} onProfile={() => setProfileOpen(true)} />}
      {screen === "home" && <Home navigate={navigate} toast={toast} />}
      {screen === "lobby" && <Lobby navigate={navigate} toast={toast} />}
      {screen === "match" && <Match navigate={navigate} toast={toast} />}
      {screen === "vote" && <Voting navigate={navigate} toast={toast} />}
      {screen === "leaderboard" && <Leaderboard navigate={navigate} />}
      {screen === "shop" && <Shop navigate={navigate} toast={toast} />}
      {profileOpen && <ProfileModal close={() => setProfileOpen(false)} toast={toast} />}
      <div className={`toast ${toastMessage ? "show" : ""}`} role="status">{toastMessage}<span>✦</span></div>
    </div>
  );
}
