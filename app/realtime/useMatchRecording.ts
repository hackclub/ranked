"use client";

import { useEffect, useRef, useState } from "react";
import {
  RECORDING_MAX_SEGMENT_BYTES,
  RECORDING_SEGMENT_MS,
} from "@/app/lib/recording-policy";

export type MatchRecordingStatus =
  | "waiting"
  | "recording"
  | "syncing"
  | "complete"
  | "unsupported"
  | "error";

const MIME_CANDIDATES = [
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "video/mp4;codecs=avc1,mp4a.40.2",
  "video/mp4",
] as const;

export function supportedRecordingMimeType() {
  if (typeof MediaRecorder === "undefined") return null;
  return MIME_CANDIDATES.find((mime) => MediaRecorder.isTypeSupported(mime)) ?? null;
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "Recording request failed.");
  return body;
}

export function useMatchRecording(
  matchId: string,
  stream: MediaStream | null,
  enabled: boolean,
) {
  const [status, setStatus] = useState<MatchRecordingStatus>("waiting");
  const [error, setError] = useState<string | null>(null);
  const recordingIdRef = useRef<string | null>(null);
  const sessionPromiseRef = useRef<Promise<string> | null>(null);
  const nextIndexRef = useRef(0);
  const pendingUploadsRef = useRef(Promise.resolve());
  const pendingCountRef = useRef(0);

  const mimeType = supportedRecordingMimeType();

  const ensureSession = async () => {
    if (recordingIdRef.current) return recordingIdRef.current;
    if (!mimeType) throw new Error("This browser cannot securely record WebRTC media.");
    sessionPromiseRef.current ??= fetch("/api/recordings/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ matchId, mimeType }),
    })
      .then((response) =>
        responseJson<{ recordingId: string; nextIndex: number }>(response),
      )
      .then((session) => {
        recordingIdRef.current = session.recordingId;
        nextIndexRef.current = Math.max(nextIndexRef.current, session.nextIndex);
        return session.recordingId;
      })
      .finally(() => {
        sessionPromiseRef.current = null;
      });
    return sessionPromiseRef.current;
  };

  const uploadSegment = async (
    recordingId: string,
    segmentIndex: number,
    blob: Blob,
    durationMs: number,
  ) => {
    if (blob.size <= 0) return;
    if (blob.size > RECORDING_MAX_SEGMENT_BYTES) {
      throw new Error("A recording clip exceeded the secure upload limit.");
    }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const prepared = await fetch(
          `/api/recordings/${encodeURIComponent(recordingId)}/segments`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ segmentIndex, mimeType: blob.type || mimeType }),
          },
        ).then((response) =>
          responseJson<{
            uploadUrl?: string;
            alreadyUploaded?: boolean;
            requiredHeaders?: Record<string, string>;
          }>(response),
        );
        if (!prepared.alreadyUploaded) {
          if (!prepared.uploadUrl) throw new Error("Recording upload URL was missing.");
          const uploaded = await fetch(prepared.uploadUrl, {
            method: "PUT",
            headers: prepared.requiredHeaders,
            body: blob,
          });
          if (!uploaded.ok) throw new Error("Private recording upload failed.");
          await fetch(
            `/api/recordings/${encodeURIComponent(recordingId)}/segments`,
            {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ segmentIndex, durationMs }),
            },
          ).then((response) => responseJson<{ ok: boolean }>(response));
        }
        return;
      } catch (reason) {
        lastError = reason;
        if (attempt < 3) {
          await new Promise((resolve) => window.setTimeout(resolve, attempt * 750));
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Private recording upload failed.");
  };

  useEffect(() => {
    if (!enabled) return;
    if (!mimeType) {
      const timer = window.setTimeout(() => {
        setStatus("unsupported");
        setError("This browser does not support secure match recording.");
      }, 0);
      return () => window.clearTimeout(timer);
    }
    if (!stream || !stream.getTracks().length) {
      const timer = window.setTimeout(() => setStatus("waiting"), 0);
      return () => window.clearTimeout(timer);
    }

    let cancelled = false;
    let recorder: MediaRecorder | null = null;
    let segmentTimer: number | undefined;

    const queueUpload = (blob: Blob, durationMs: number) => {
      const segmentIndex = nextIndexRef.current++;
      pendingCountRef.current += 1;
      pendingUploadsRef.current = pendingUploadsRef.current
        .then(async () => {
          const recordingId = await ensureSession();
          await uploadSegment(recordingId, segmentIndex, blob, durationMs);
        })
        .then(() => {
          pendingCountRef.current -= 1;
          if (!cancelled) setStatus(pendingCountRef.current ? "syncing" : "recording");
        })
        .catch((reason) => {
          pendingCountRef.current -= 1;
          console.error("Match recording upload failed", reason);
          if (!cancelled) {
            setStatus("error");
            setError(reason instanceof Error ? reason.message : "Recording upload failed.");
          }
        });
    };

    const startSegment = async () => {
      try {
        await ensureSession();
        if (cancelled) return;
        const startedAt = performance.now();
        const chunks: BlobPart[] = [];
        recorder = new MediaRecorder(stream, {
          mimeType,
          videoBitsPerSecond: 700_000,
          audioBitsPerSecond: 64_000,
        });
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data.size) chunks.push(event.data);
        });
        recorder.addEventListener("error", () => {
          setStatus("error");
          setError("The browser stopped recording this match.");
        });
        recorder.addEventListener("stop", () => {
          window.clearTimeout(segmentTimer);
          if (chunks.length) {
            queueUpload(
              new Blob(chunks, { type: mimeType }),
              Math.max(0, Math.round(performance.now() - startedAt)),
            );
          }
          if (!cancelled) void startSegment();
        });
        recorder.start();
        setStatus("recording");
        segmentTimer = window.setTimeout(() => {
          if (recorder?.state === "recording") recorder.stop();
        }, RECORDING_SEGMENT_MS);
      } catch (reason) {
        console.error("Match recording could not start", reason);
        if (!cancelled) {
          setStatus("error");
          setError(reason instanceof Error ? reason.message : "Recording could not start.");
        }
      }
    };
    void startSegment();

    return () => {
      cancelled = true;
      window.clearTimeout(segmentTimer);
      if (recorder?.state === "recording") recorder.stop();
    };
  // The MediaStream object changes when the participant changes devices.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, matchId, mimeType, stream]);

  useEffect(() => {
    if (enabled || !recordingIdRef.current) return;
    setStatus("syncing");
    const recordingId = recordingIdRef.current;
    void pendingUploadsRef.current.finally(() => {
      void fetch("/api/recordings/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId }),
        keepalive: true,
      }).finally(() => setStatus("complete"));
    });
  }, [enabled]);

  useEffect(() => {
    return () => {
      const recordingId = recordingIdRef.current;
      if (!recordingId) return;
      void fetch("/api/recordings/session", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recordingId }),
        keepalive: true,
      });
    };
  }, [matchId]);

  return { status, error };
}
