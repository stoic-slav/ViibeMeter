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
  signature?: string;     // unmatched only: base64 ShazamKit fingerprint (irreversible), to learn DJ edits
  edit?: { id: string | null; dj: string | null; title: string | null }; // unmatched, but a known DJ edit
  error?: string;
}

export interface EditCatalogEntry {
  id: string;
  signature: string;      // base64 ShazamKit signature
  dj: string | null;
  title: string | null;
  link?: string | null;   // JS only (the edit's or DJ's page), not passed to ShazamKit
}

interface AudioCaptureNative {
  start(bufferSeconds: number): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  readRecent(seconds: number): Promise<RecentAudio>;
  readRange(fromMs: number, toMs: number): Promise<RecentAudio>;
  getBassEnvelope(fromMs: number, toMs: number): Promise<(number | null)[]>;
  matchRecent(seconds: number): Promise<ShazamMatchResult>;
  isInVehicle(): Promise<boolean>;
  loadEditCatalog(entries: EditCatalogEntry[]): Promise<number>;
  signatureRecent(seconds: number): Promise<string | null>;
  setRollingPrints(enabled: boolean): void;
  takeRolledSignature(): Promise<{ signature: string; startMs: number; endMs: number } | null>;
  beginReferenceSignature(): void;
  endReferenceSignature(): Promise<string | null>;
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

/** Audio for the wall-clock range [fromMs, toMs), clipped to what the buffer holds. */
export async function readRange(fromMs: number, toMs: number): Promise<RecentAudio | null> {
  return native ? native.readRange(fromMs, toMs) : null;
}

/** Bass level (dB) per 250 ms wall-clock frame in [fromMs, toMs); null = not captured. */
export async function getBassEnvelope(fromMs: number, toMs: number): Promise<(number | null)[] | null> {
  return native ? native.getBassEnvelope(fromMs, toMs) : null;
}

export async function matchRecent(seconds: number): Promise<ShazamMatchResult | null> {
  return native ? native.matchRecent(seconds) : null;
}

/** Loads the DJ edit catalog for matching on the phone; returns how many references loaded. */
export async function loadEditCatalog(entries: EditCatalogEntry[]): Promise<number> {
  return native ? native.loadEditCatalog(entries) : 0;
}

/** A ShazamKit fingerprint (base64) of the last `seconds` of audio, for registering a DJ edit. */
export async function signatureRecent(seconds: number): Promise<string | null> {
  return native ? native.signatureRecent(seconds) : null;
}

/** Rolling 30 s fingerprints (sessions only), to learn DJ edits from music Shazam can't name. */
export function setRollingPrints(enabled: boolean): void {
  try { native?.setRollingPrints(enabled); } catch {}
}

/** The latest completed 30 s fingerprint, taken once (null if none since the last call). */
export async function takeRolledSignature(): Promise<{ signature: string; startMs: number; endMs: number } | null> {
  try {
    return native ? await native.takeRolledSignature() : null;
  } catch {
    return null;
  }
}

/** A DJ's reference recording: one continuous fingerprint between begin and end. */
export function beginReferenceSignature(): void {
  try { native?.beginReferenceSignature(); } catch {}
}

export async function endReferenceSignature(): Promise<string | null> {
  try {
    return native ? await native.endReferenceSignature() : null;
  } catch {
    return null;
  }
}

/** iOS motion activity says the phone is in a vehicle (false when unknown or not allowed). */
export async function isInVehicle(): Promise<boolean> {
  try {
    return native ? await native.isInVehicle() : false;
  } catch {
    return false;
  }
}
