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
};

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

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (process.env.NEXT_PUBLIC_TURN_URL) {
    servers.push({
      urls: process.env.NEXT_PUBLIC_TURN_URL,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export function useRealtimeRoom(roomId: string, mic: boolean, video: boolean, scope: "team" | "everyone", team: "blue" | "red", micDeviceId?: string, videoDeviceId?: string) {
  const [room, setRoom] = useState<Room | null>(null);
  const [status, setStatus] = useState("connecting");
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const peersRef = useRef(new Map<number, PeerState>());
  const streamRef = useRef<MediaStream | null>(null);
  const roomRef = useRef<Room | null>(null);
  const settingsRef = useRef({ mic, video, scope, team });
  useEffect(() => { settingsRef.current = { mic, video, scope, team }; }, [mic, scope, team, video]);

  useEffect(() => {
    let cancelled = false;
    const entered = liveblocksClient().enterRoom(roomId, {
      initialPresence: { callReady: true, mic, video, scope, team },
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
        team: other?.presence.team ?? "red",
      };
    };

    const ensurePeer = (connectionId: number) => {
      const existing = activePeers.get(connectionId);
      if (existing) return existing;
      const selfId = joinedRoom.getSelf()?.connectionId ?? 0;
      const state: PeerState = {
        pc: new RTCPeerConnection({ iceServers: iceServers() }),
        makingOffer: false,
        ignoreOffer: false,
        isSettingRemoteAnswerPending: false,
        polite: selfId > connectionId,
      };
      activePeers.set(connectionId, state);
      streamRef.current?.getTracks().forEach(track => {
        const clone = track.clone();
        const otherTeam = joinedRoom.getOthers().find(other => other.connectionId === connectionId)?.presence.team;
        const settings = settingsRef.current;
        clone.enabled = clone.kind === "video" ? settings.video : settings.mic && (settings.scope === "everyone" || otherTeam === settings.team);
        state.pc.addTrack(clone, streamRef.current!);
      });
      state.pc.onicecandidate = ({ candidate }) => {
        if (candidate) sendSignal(connectionId, { candidate: candidate.toJSON() as Liveblocks["RoomEvent"]["candidate"] });
      };
      state.pc.ontrack = ({ streams }) => {
        const stream = streams[0];
        if (!stream) return;
        setRemotePeers(current => [...current.filter(peer => peer.connectionId !== connectionId), peerDetails(connectionId, stream)]);
      };
      let disconnectTimer: number | undefined;
      state.pc.onconnectionstatechange = () => {
        const current = state.pc.connectionState;
        if (current === "failed" || current === "closed") {
          window.clearTimeout(disconnectTimer);
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

    navigator.mediaDevices.getUserMedia({
      audio: micDeviceId ? { deviceId: { exact: micDeviceId } } : true,
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
    }).then(stream => {
      if (cancelled) { stream.getTracks().forEach(track => track.stop()); return; }
      stream.getAudioTracks().forEach(track => { track.enabled = mic; });
      stream.getVideoTracks().forEach(track => { track.enabled = video; });
      streamRef.current = stream;
      setLocalStream(stream);
      for (const [connectionId, state] of activePeers) stream.getTracks().forEach(track => {
        const clone = track.clone();
        const otherTeam = joinedRoom.getOthers().find(other => other.connectionId === connectionId)?.presence.team;
        const settings = settingsRef.current;
        clone.enabled = clone.kind === "video" ? settings.video : settings.mic && (settings.scope === "everyone" || otherTeam === settings.team);
        state.pc.addTrack(clone, stream);
      });
    }).catch(error => {
      console.error("Camera/microphone permission failed", error);
      setStatus("media-blocked");
    });

    return () => {
      cancelled = true;
      unsubscribeStatus();
      unsubscribeOthers();
      unsubscribeEvents();
      for (const state of activePeers.values()) { state.pc.getSenders().forEach(sender => sender.track?.stop()); state.pc.close(); }
      activePeers.clear();
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      roomRef.current = null;
      leave();
    };
  // Room membership should only restart when the room changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [micDeviceId, roomId, videoDeviceId]);

  useEffect(() => {
    streamRef.current?.getAudioTracks().forEach(track => { track.enabled = mic; });
    streamRef.current?.getVideoTracks().forEach(track => { track.enabled = video; });
    roomRef.current?.updatePresence({ mic, video, scope, team });
    for (const [connectionId, state] of peersRef.current) {
      const peerTeam = roomRef.current?.getOthers().find(other => other.connectionId === connectionId)?.presence.team;
      for (const sender of state.pc.getSenders()) {
        if (!sender.track) continue;
        sender.track.enabled = sender.track.kind === "video" ? video : mic && (scope === "everyone" || peerTeam === team);
      }
    }
  }, [mic, video, scope, team]);

  return { room, status, localStream, remotePeers };
}
