"use client";

import { createClient, type Room } from "@liveblocks/client";
import { useEffect, useRef, useState } from "react";
import type { ResolvedAvatarConfig } from "@/app/lib/avatar";

let sharedClient: ReturnType<typeof createClient> | null = null;

function liveblocksClient() {
  sharedClient ??= createClient({ authEndpoint: "/api/liveblocks-auth" });
  return sharedClient;
}

export function useCodeRoom(roomId: string | null) {
  const [room, setRoom] = useState<Room | null>(null);
  useEffect(() => {
    if (!roomId) return;
    const entered = liveblocksClient().enterRoom(roomId, { initialPresence: { callReady: false, mic: false, video: false, scope: "team", team: "blue" } });
    const joined = entered.room as unknown as Room;
    const { leave } = entered;
    const timer = window.setTimeout(() => setRoom(joined), 0);
    return () => { window.clearTimeout(timer); setRoom(null); leave(); };
  }, [roomId]);
  return room;
}

type PeerState = {
  pc: RTCPeerConnection;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  polite: boolean;
  name: string;
  team: "blue" | "red";
  videoLostNotified: boolean;
};

export type PeerVideoLost = { connectionId: number; name: string; team: "blue" | "red" };

type RemotePeer = {
  connectionId: number;
  name: string;
  color: string;
  avatar?: ResolvedAvatarConfig;
  stream: MediaStream;
  mic: boolean;
  video: boolean;
  team: "blue" | "red";
};

type RtcConfig = Pick<RTCConfiguration, "iceServers" | "iceTransportPolicy">;

const FALLBACK_RTC_CONFIG: RtcConfig = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }],
  iceTransportPolicy: "all",
};

// ICE servers come from the server, per match, rather than from build-time
// env vars: that keeps TURN credentials out of the public bundle (they're
// short-lived and only issued to players in the match) and lets the server
// decide whether calls must be relayed so peers never see each other's IPs.
// It has to be known before the first RTCPeerConnection exists — a relay-only
// policy applied after ICE gathering has started is too late.
async function loadRtcConfig(roomId: string, signal: AbortSignal): Promise<RtcConfig> {
  const matchId = roomId.match(/^ranked:call:([^:]+)$/)?.[1];
  if (!matchId) return FALLBACK_RTC_CONFIG;
  for (let attempt = 1; attempt <= 4 && !signal.aborted; attempt++) {
    try {
      const response = await fetch(`/api/matches/${encodeURIComponent(matchId)}/ice-servers`, { cache: "no-store", signal });
      if (response.ok) {
        const data = (await response.json()) as { iceServers?: RTCIceServer[]; iceTransportPolicy?: string };
        if (Array.isArray(data.iceServers)) {
          return { iceServers: data.iceServers, iceTransportPolicy: data.iceTransportPolicy === "relay" ? "relay" : "all" };
        }
      } else if (response.status < 500) {
        break;
      }
    } catch {
      // Network hiccup — retried below.
    }
    await new Promise((resolve) => window.setTimeout(resolve, attempt * 600));
  }
  return FALLBACK_RTC_CONFIG;
}

export type CallPolicy = {
  // False tears the call down completely: the room is left, every peer
  // connection is closed and the camera and microphone are released. The call
  // only exists while the match is live, which is also the only time it is
  // recorded.
  enabled: boolean;
  // False keeps the call up but sends nothing to it: every outgoing track is
  // disabled, while the local stream stays live so the recorder can keep
  // trying. Used while this player has no working safety recording, so that
  // nothing unrecorded ever reaches another player.
  transmit: boolean;
};

export function useRealtimeRoom(roomId: string, mic: boolean, video: boolean, scope: "team" | "everyone", team: "blue" | "red", micDeviceId?: string, videoDeviceId?: string, onPeerVideoLost?: (peer: PeerVideoLost) => void, policy: CallPolicy = { enabled: true, transmit: true }) {
  const { enabled, transmit } = policy;
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState("connecting");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const peersRef = useRef(new Map<number, PeerState>());
  const streamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const settingsRef = useRef({ mic, video, scope, team, transmit });
  useEffect(() => { settingsRef.current = { mic, video, scope, team, transmit }; }, [mic, scope, team, transmit, video]);
  const onPeerVideoLostRef = useRef(onPeerVideoLost);
  useEffect(() => { onPeerVideoLostRef.current = onPeerVideoLost; }, [onPeerVideoLost]);

  const [rtcConfig, setRtcConfig] = useState<{ roomId: string; config: RtcConfig } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void loadRtcConfig(roomId, controller.signal).then((config) => {
      if (!controller.signal.aborted) setRtcConfig({ roomId, config });
    });
    return () => controller.abort();
  }, [enabled, roomId]);
  const activeRtcConfig = rtcConfig?.roomId === roomId ? rtcConfig.config : null;

  useEffect(() => {
    if (!activeRtcConfig || !enabled) return;
    let cancelled = false;
    const entered = liveblocksClient().enterRoom(roomId, {
      initialPresence: { callReady: true, mic: mic && transmit, video: video && transmit, scope, team },
    });
    const joinedRoom = entered.room as unknown as Room;
    const { leave } = entered;
    roomRef.current = joinedRoom;
    window.setTimeout(() => setRoom(joinedRoom), 0);
    const activePeers = peersRef.current;

    const sendSignal = (target: number, payload: Omit<Liveblocks["RoomEvent"], "type" | "target">) => {
      joinedRoom.broadcastEvent({ type: "rtc-signal", target, ...payload }, { shouldQueueEventIfNotReady: true });
    };

    const peerDetails = (connectionId: number, stream: MediaStream): RemotePeer => {
      const other = joinedRoom.getOthers().find(candidate => candidate.connectionId === connectionId);
      return {
        connectionId,
        name: other?.info?.name ?? "Player",
        color: other?.info?.color ?? "#D99F6C",
        avatar: other?.info?.avatarConfig,
        stream,
        mic: other?.presence.mic ?? true,
        video: other?.presence.video ?? true,
        team: other?.info?.team ?? other?.presence.team ?? "red",
      };
    };

    const notifyVideoLost = (connectionId: number, state: PeerState) => {
      if (state.videoLostNotified) return;
      state.videoLostNotified = true;
      onPeerVideoLostRef.current?.({ connectionId, name: state.name, team: state.team });
    };

    const ensurePeer = (connectionId: number) => {
      const existing = activePeers.get(connectionId);
      if (existing) return existing;
      const selfId = joinedRoom.getSelf()?.connectionId ?? 0;
      const other = joinedRoom.getOthers().find(candidate => candidate.connectionId === connectionId);
      const state: PeerState = {
        pc: new RTCPeerConnection(activeRtcConfig),
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: selfId > connectionId,
        name: other?.info?.name ?? "Player",
        team: other?.info?.team ?? other?.presence.team ?? "red",
        videoLostNotified: false,
      };
      activePeers.set(connectionId, state);
      streamRef.current?.getTracks().forEach(track => {
        const clone = track.clone();
        // Team-only audio is gated on info.team (set by the server when it
        // authorizes the room), not presence.team, which any client can set
        // to whatever it likes to listen in on the other team.
        const otherTeam = joinedRoom.getOthers().find(other => other.connectionId === connectionId)?.info?.team;
        const settings = settingsRef.current;
        clone.enabled = settings.transmit && (clone.kind === "video" ? settings.video : settings.mic && (settings.scope === "everyone" || otherTeam === settings.team));
        state.pc.addTrack(clone, streamRef.current!);
      });
      state.pc.onicecandidate = ({ candidate }) => {
        if (candidate) sendSignal(connectionId, { candidate: candidate.toJSON() as Liveblocks["RoomEvent"]["candidate"] });
      };
      state.pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (!stream) return;
        state.videoLostNotified = false;
        setRemotePeers(current => [...current.filter(peer => peer.connectionId !== connectionId), peerDetails(connectionId, stream)]);
      };
      let disconnectTimer: number | undefined;
      state.pc.onconnectionstatechange = () => {
        const current = state.pc.connectionState;
        if (current === "failed" || current === "closed") {
          window.clearTimeout(disconnectTimer);
          notifyVideoLost(connectionId, state);
          setRemotePeers(peers => peers.filter(peer => peer.connectionId !== connectionId));
          return;
        }
        if (current === "disconnected") {
          // "disconnected" is often transient (e.g. a brief ICE keepalive miss right
          // after the initial handshake) and commonly self-heals back to "connected"
          // a moment later. Only drop the tile if it hasn't recovered after a grace
          // period, instead of tearing it down immediately.
          window.clearTimeout(disconnectTimer);
          disconnectTimer = window.setTimeout(() => {
            if (state.pc.connectionState !== "connected") {
              notifyVideoLost(connectionId, state);
              setRemotePeers(peers => peers.filter(peer => peer.connectionId !== connectionId));
            }
          }, 8000);
          return;
        }
        window.clearTimeout(disconnectTimer);
      };
      state.pc.onnegotiationneeded = async () => {
        try {
          state.makingOffer = true;
          await state.pc.setLocalDescription();
          const description = state.pc.localDescription;
          if (description) sendSignal(connectionId, { description: { type: description.type, sdp: description.sdp } });
        } catch (error) {
          console.error("WebRTC negotiation failed", error);
        } finally {
          state.makingOffer = false;
        }
      };
      return state;
    };

    const syncPeers = () => {
      const active = new Set(joinedRoom.getOthers().filter(other => other.presence.callReady).map(other => other.connectionId));
      for (const id of active) ensurePeer(id);
      for (const [id, peer] of activePeers) {
        if (!active.has(id)) {
          notifyVideoLost(id, peer);
          peer.pc.getSenders().forEach(sender => sender.track?.stop());
          peer.pc.close();
          activePeers.delete(id);
          setRemotePeers(current => current.filter(remote => remote.connectionId !== id));
        }
      }
      setRemotePeers(current => current.map(remote => peerDetails(remote.connectionId, remote.stream)));
    };

    const unsubscribeStatus = joinedRoom.subscribe("status", next => {
      setStatus(next);
      if (next === "connected") syncPeers();
    });
    const unsubscribeOthers = joinedRoom.subscribe("others", syncPeers);
    const unsubscribeEvents = joinedRoom.subscribe("event", async ({ event, connectionId }) => {
      if (event.type !== "rtc-signal" || event.target !== joinedRoom.getSelf()?.connectionId) return;
      const state = ensurePeer(connectionId);
      try {
        if (event.description) {
          const readyForOffer = !state.makingOffer && (state.pc.signalingState === "stable" || state.isSettingRemoteAnswerPending);
          const offerCollision = event.description.type === "offer" && !readyForOffer;
          state.ignoreOffer = !state.polite && offerCollision;
          if (state.ignoreOffer) return;
          state.isSettingRemoteAnswerPending = event.description.type === "answer";
          await state.pc.setRemoteDescription(event.description as RTCSessionDescriptionInit);
          state.isSettingRemoteAnswerPending = false;
          if (event.description.type === "offer") {
            await state.pc.setLocalDescription();
            const description = state.pc.localDescription;
            if (description) sendSignal(connectionId, { description: { type: description.type, sdp: description.sdp } });
          }
        } else if (event.candidate) {
          try { await state.pc.addIceCandidate(event.candidate); } catch (error) { if (!state.ignoreOffer) throw error; }
        }
      } catch (error) {
        console.error("WebRTC signal failed", error);
      }
    });

    // Right after a page refresh, the just-torn-down old tab can still be
    // holding the camera/mic for a moment (OS-level device release isn't
    // instant), so the very first getUserMedia() call here can fail with a
    // transient "device in use" error even though nothing is actually wrong.
    // Retry a few times with backoff before giving up — a single failed
    // attempt used to be permanent (no retry, no user-visible message),
    // which is exactly what made video never come back after a refresh.
    let retryTimer: number | undefined;
    const acquireMedia = async (attempt = 1) => {
      if (cancelled) return;
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
          video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
        });
        if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
        stream.getAudioTracks().forEach(track => { track.enabled = mic; });
        stream.getVideoTracks().forEach(track => { track.enabled = video; });
        streamRef.current = stream;
        setLocalStream(stream);
        for (const [connectionId, state] of activePeers) stream.getTracks().forEach(track => {
          const clone = track.clone();
          const otherTeam = joinedRoom.getOthers().find(other => other.connectionId === connectionId)?.info?.team;
          const settings = settingsRef.current;
          clone.enabled = settings.transmit && (clone.kind === "video" ? settings.video : settings.mic && (settings.scope === "everyone" || otherTeam === settings.team));
          state.pc.addTrack(clone, stream);
        });
      } catch (error) {
        if (cancelled) return;
        if (attempt >= 4) {
          console.error("Camera/microphone permission failed", error);
          setStatus("media-blocked");
          return;
        }
        retryTimer = window.setTimeout(() => void acquireMedia(attempt + 1), attempt * 800);
      }
    };
    void acquireMedia();

    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      unsubscribeStatus();
      unsubscribeOthers();
      unsubscribeEvents();
      for (const state of activePeers.values()) { state.pc.getSenders().forEach(sender => sender.track?.stop()); state.pc.close(); }
      activePeers.clear();
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      roomRef.current = null;
      // Whatever is left on screen must not outlive the call: a stale stream
      // here would keep a recorder (and a video tile) attached to dead tracks.
      setLocalStream(null);
      setRemotePeers([]);
      leave();
    };
  // Room membership should only restart when the room changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRtcConfig, enabled, micDeviceId, roomId, videoDeviceId]);

  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = mic; });
    streamRef.current?.getVideoTracks().forEach(track => { track.enabled = video; });
    // Presence is what tells the other players whether to expect audio or
    // video from this one, so it reports what is actually being sent.
    roomRef.current?.updatePresence({ mic: mic && transmit, video: video && transmit, scope, team });
    for (const [connectionId, state] of peersRef.current) {
      const peerTeam = roomRef.current?.getOthers().find(other => other.connectionId === connectionId)?.info?.team;
      for (const sender of state.pc.getSenders()) {
        if (!sender.track) continue;
        sender.track.enabled = transmit && (sender.track.kind === "video" ? video : mic && (scope === "everyone" || peerTeam === team));
      }
    }
  }, [mic, video, scope, team, transmit]);

  return { room, status, localStream, remotePeers };
}
