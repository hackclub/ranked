"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import styles from "./reviewer.module.css";

type Participant = {
  name: string;
  email: string;
  team: "blue" | "red";
  slot: number;
};

type Segment = {
  id: string;
  index: number;
  durationMs: number | null;
  sizeBytes: number | null;
};

type Recording = {
  recordingId: string;
  matchId: string;
  participantName: string;
  participantEmail: string;
  status: string;
  mimeType: string;
  startedAt: string;
  completedAt: string | null;
  expiresAt: string;
  theme: string;
  mode: string;
  durationMinutes: number;
  matchStartedAt: string;
  matchEndedAt: string | null;
  participants: Participant[];
  segments: Segment[];
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function RecordingReviewDashboard({
  reviewerEmail,
}: {
  reviewerEmail: string;
}) {
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [segmentCursor, setSegmentCursor] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/reviewer/recordings", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Recording access was denied.");
        return response.json() as Promise<{ recordings?: Recording[] }>;
      })
      .then((result) => {
        if (cancelled) return;
        const next = result.recordings ?? [];
        setRecordings(next);
        setSelectedId(next[0]?.recordingId ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Could not load recordings.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    const grouped = new Map<string, Recording[]>();
    for (const recording of recordings) {
      const current = grouped.get(recording.matchId) ?? [];
      current.push(recording);
      grouped.set(recording.matchId, current);
    }
    return [...grouped.entries()];
  }, [recordings]);
  const selected = recordings.find((recording) => recording.recordingId === selectedId) ?? null;
  const segment = selected?.segments[segmentCursor] ?? null;

  const selectRecording = (recordingId: string) => {
    setSelectedId(recordingId);
    setSegmentCursor(0);
  };

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <span className={styles.privateBadge}>restricted · audited</span>
          <h1>Recording review</h1>
          <p>Private safety recordings. Automatically removed after 10 days.</p>
        </div>
        <div className={styles.identity}>
          <strong>{reviewerEmail}</strong>
          <Link href="/">back to Ranked</Link>
        </div>
      </header>

      {loading ? (
        <section className={styles.state}>Loading private recordings…</section>
      ) : error ? (
        <section className={styles.state}>{error}</section>
      ) : !recordings.length ? (
        <section className={styles.state}>No recordings are currently inside the 10-day retention window.</section>
      ) : (
        <div className={styles.layout}>
          <aside className={styles.list} aria-label="Recorded matches">
            {matches.map(([matchId, matchRecordings]) => {
              const first = matchRecordings[0];
              return (
                <section className={styles.matchCard} key={matchId}>
                  <div className={styles.matchMeta}>
                    <strong>{first.theme}</strong>
                    <span>{formatDate(first.matchStartedAt)}</span>
                    <small>{first.mode} · {first.durationMinutes} minutes</small>
                  </div>
                  <div className={styles.roster}>
                    {first.participants.map((participant) => (
                      <div key={`${matchId}-${participant.email}`}>
                        <span className={participant.team === "blue" ? styles.blueDot : styles.redDot} />
                        <p><strong>{participant.name}</strong><small>{participant.email}</small></p>
                      </div>
                    ))}
                  </div>
                  <div className={styles.recordingButtons}>
                    {matchRecordings.map((recording) => (
                      <button
                        key={recording.recordingId}
                        className={recording.recordingId === selectedId ? styles.selected : ""}
                        onClick={() => selectRecording(recording.recordingId)}
                        disabled={!recording.segments.length}
                      >
                        {recording.participantName}
                        <small>{recording.segments.length} clips</small>
                      </button>
                    ))}
                  </div>
                </section>
              );
            })}
          </aside>

          <section className={styles.playerPanel}>
            {selected && segment ? (
              <>
                <div className={styles.playerHeading}>
                  <div>
                    <span>participant recording</span>
                    <h2>{selected.participantName}</h2>
                    <p>{selected.participantEmail}</p>
                  </div>
                  <div>
                    <small>recorded</small>
                    <strong>{formatDate(selected.startedAt)}</strong>
                    <small>expires</small>
                    <strong>{formatDate(selected.expiresAt)}</strong>
                  </div>
                </div>
                <video
                  key={`${selected.recordingId}-${segment.id}`}
                  className={styles.video}
                  src={`/api/reviewer/recordings/${selected.recordingId}/segments/${segment.id}`}
                  controls
                  controlsList="nodownload noremoteplayback"
                  disablePictureInPicture
                  playsInline
                  onEnded={() => {
                    if (segmentCursor + 1 < selected.segments.length) {
                      setSegmentCursor((current) => current + 1);
                    }
                  }}
                />
                <div className={styles.segmentNav}>
                  <button
                    onClick={() => setSegmentCursor((current) => Math.max(0, current - 1))}
                    disabled={segmentCursor === 0}
                  >
                    previous clip
                  </button>
                  <span>clip {segmentCursor + 1} of {selected.segments.length}</span>
                  <button
                    onClick={() => setSegmentCursor((current) => Math.min(selected.segments.length - 1, current + 1))}
                    disabled={segmentCursor + 1 >= selected.segments.length}
                  >
                    next clip
                  </button>
                </div>
                <p className={styles.notice}>Every dashboard open and playback is recorded in the security audit log.</p>
              </>
            ) : (
              <div className={styles.state}>Select a participant recording to begin review.</div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}
