import type { ResolvedAvatarConfig } from "./app/lib/avatar";

export {};

declare global {
  interface Liveblocks {
    Presence: {
      callReady: boolean;
      mic: boolean;
      video: boolean;
      scope: "team" | "everyone";
      team: "blue" | "red";
    };
    UserMeta: {
      id: string;
      info: {
        name: string;
        color: string;
        avatarConfig: ResolvedAvatarConfig;
        team: "blue" | "red";
      };
    };
    RoomEvent: {
      type: "rtc-signal";
      target: number;
      description?: { type: "offer" | "answer" | "pranswer" | "rollback"; sdp?: string };
      candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null; usernameFragment: string | null };
    };
  }
}
