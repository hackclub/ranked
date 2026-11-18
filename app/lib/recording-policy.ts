export const RECORDING_POLICY_VERSION = "2026-08-26";
export const RECORDING_RETENTION_DAYS = 10;
export const RECORDING_SEGMENT_MS = 10_000;
export const RECORDING_MAX_SEGMENT_BYTES = 12 * 1024 * 1024;

export function recordingConsentCopy() {
  return `I consent to my match audio and video being recorded for safety and retained for ${RECORDING_RETENTION_DAYS} days. Recordings will only ever be viewed if there is a conduct report.`;
}

const RECORDING_MIME_PATTERN = /^(?:video|audio)\/(?:webm|mp4)(?:;\s*codecs=[a-z0-9.,_-]+)?$/i;

export function validRecordingMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 120 &&
    RECORDING_MIME_PATTERN.test(value.trim())
  );
}

export function recordingExtension(mimeType: string) {
  return mimeType.toLowerCase().includes("mp4") ? "mp4" : "webm";
}
