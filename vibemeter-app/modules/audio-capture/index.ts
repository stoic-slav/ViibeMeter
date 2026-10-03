import { requireOptionalNativeModule } from 'expo';

export interface RecentAudio {
  pcm: string;          // base64, 16-bit little-endian mono PCM
  count: number;        // number of samples
  sampleRate: number;
  startMs: number;      // wall-clock time (Date.now() clock) of the first sample
}

export interface ShazamMatchResult {
  matched: boolean;
  title?: string | null;
  artist?: string | null;
  isrc?: string | null;
  genres?: string[];
  appleMusicID?: string | null;
  matchOffset?: number;   // s into the track where the matched audio starts
  queryStartMs?: number;  // wall-clock time of the matched audio's first sample
  trackStartMs?: number;  // wall-clock time this playback of the track began
  error?: string;
}

interface AudioCaptureNative {
  start(bufferSeconds: number): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  readRecent(seconds: number): Promise<RecentAudio>;
  matchRecent(seconds: number): Promise<ShazamMatchResult>;
}

// iOS only. Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<AudioCaptureNative>('AudioCapture');

export const isAudioCaptureAvailable = native != null;

export async function startCapture(bufferSeconds: number): Promise<void> {
  await native?.start(bufferSeconds);
}

export async function stopCapture(): Promise<void> {
  await native?.stop();
}

export function isCapturing(): boolean {
  return native?.isRunning() ?? false;
}

export async function readRecent(seconds: number): Promise<RecentAudio | null> {
  return native ? native.readRecent(seconds) : null;
}

export async function matchRecent(seconds: number): Promise<ShazamMatchResult | null> {
  return native ? native.matchRecent(seconds) : null;
}
