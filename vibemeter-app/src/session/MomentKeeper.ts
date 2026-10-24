import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { MOMENTS, SUPABASE_CONFIG } from '../config/constants';
import { AudioMetrics, MotionMetrics, Session } from '../types';
import { isAudioCaptureAvailable, readRange, excludeFromBackup } from '../../modules/audio-capture';
import { processClip, encodeWav, toBase64, macroYield } from '../processing/ClipCleaner';
import { momentsEnabled, getMomentSettings } from '../storage/MomentSettings';
import { getDeviceId } from '../storage/DeviceIdentity';
import {
  MomentRow, saveMoment, getSessionMoments, getMoment, getMomentsToShare, markMomentShared,
  getExpiredMoments, deleteMomentRow, getUnprocessedMoments, updateMomentAnalysis,
} from '../storage/LocalBuffer';

/**
 * "Best moments" (build 29; opt-in, off by default). While a session runs, the clips of the
 * person's strongest dancing are kept: about 15 s of the room's music cut from the continuous
 * microphone buffer. Rules:
 * - the clips live in the app's own folder, out of iCloud backups, and are deleted after
 *   MOMENTS.RETAIN_DAYS days; the person can delete any of them;
 * - a clip must come from music (loud, not voices), from a moving person on a body who is not
 *   walking, and from the person's top fifth of their own night;
 * - after the session, each clip is cleaned on the phone (`ClipCleaner`: rustle bursts down,
 *   levelled) and checked again for music dominance; a clip that turns out to be mostly rustle or
 *   not bass-led is deleted;
 * - only with a second opt-in ("send them to us"), the raw and the cleaned clip go to our private
 *   storage (Edge Function `moments`), where analysis/clip_enhance.py compares cleaning layers
 *   and merges phones that heard the same moment. They are deleted there when deleted here.
 * Titles and artists stay on the phone.
 */

const LOG_TAG = '[Moments]';
const SAMPLE_RATE = 44100;
const DIR = `${FileSystem.documentDirectory}moments/`;
const DAY_MS = 24 * 60 * 60 * 1000;

const ON_BODY_MOVING = new Set(['on_body_moving']);

let history: { sessionId: string; energies: number[]; lastKeptAt: number; kept: { id: string; score: number }[] } | null = null;
let capturing = false;
let processing = false;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
    excludeFromBackup(DIR);
  }
}

function decodePcm(base64: string): Int16Array {
  const binary = atob(base64);
  const out = new Int16Array(Math.floor(binary.length / 2));
  for (let i = 0; i < out.length; i++) {
    let s = binary.charCodeAt(2 * i) | (binary.charCodeAt(2 * i + 1) << 8);
    if (s >= 32768) s -= 65536;
    out[i] = s;
  }
  return out;
}

async function readWavSamples(path: string): Promise<Int16Array> {
  const b64 = await FileSystem.readAsStringAsync(path, { encoding: FileSystem.EncodingType.Base64 });
  const binary = atob(b64);
  const n = Math.floor((binary.length - 44) / 2);
  const out = new Int16Array(Math.max(0, n));
  for (let i = 0; i < out.length; i++) {
    let s = binary.charCodeAt(44 + 2 * i) | (binary.charCodeAt(45 + 2 * i) << 8);
    if (s >= 32768) s -= 65536;
    out[i] = s;
  }
  return out;
}

async function writeWav(path: string, pcm: Int16Array): Promise<void> {
  await FileSystem.writeAsStringAsync(path, toBase64(encodeWav(pcm, SAMPLE_RATE)), { encoding: FileSystem.EncodingType.Base64 });
}

async function removeFiles(m: Pick<MomentRow, 'rawPath' | 'cleanPath'>): Promise<void> {
  await FileSystem.deleteAsync(m.rawPath, { idempotent: true }).catch(() => {});
  if (m.cleanPath) await FileSystem.deleteAsync(m.cleanPath, { idempotent: true }).catch(() => {});
}

/** Calls the `moments` Edge Function; delete actions throw when the server can't be reached. */
async function momentsCall(params: Record<string, string>, fileUri?: string): Promise<void> {
  const query = new URLSearchParams(params).toString();
  const url = `${SUPABASE_CONFIG.URL}/functions/v1/moments?${query}`;
  const headers = { Authorization: `Bearer ${SUPABASE_CONFIG.ANON_KEY}`, apikey: SUPABASE_CONFIG.ANON_KEY, 'Content-Type': 'audio/wav' };
  if (fileUri) {
    const res = await FileSystem.uploadAsync(url, fileUri, { httpMethod: 'POST', uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT, headers });
    if (res.status !== 200) throw new Error(`moments ${params.action}: ${res.status}`);
    return;
  }
  const res = await fetch(url, { method: 'POST', headers });
  if (!res.ok) throw new Error(`moments ${params.action}: ${res.status}`);
}

class MomentKeeper {
  /**
   * Called after each 10 s cycle of a running session. Cheap: it only decides, and cuts and
   * writes a clip when this cycle is one of the night's strongest.
   */
  async consider(c: {
    session: Session; cycleStartMs: number; audio: AudioMetrics | null; motion: MotionMetrics | null;
    plv: number | null; tempoMatch: number | null;
  }): Promise<void> {
    if (Platform.OS !== 'ios' || !isAudioCaptureAvailable || !momentsEnabled().keep || capturing) return;
    const { session, motion, audio } = c;

    if (!history || history.sessionId !== session.id) {
      const existing = await getSessionMoments(session.id);
      history = {
        sessionId: session.id, energies: [], kept: existing.map(m => ({ id: m.id, score: m.score })),
        lastKeptAt: existing.reduce((t, m) => Math.max(t, m.startedAt + m.durationMs), 0),
      };
    }
    // Only a moving person on a body, not walking, tells us about dancing
    if (!motion || motion.movementEnergy == null || !ON_BODY_MOVING.has(motion.phoneContext) || motion.movementClassification === 'walking') return;
    const energy = motion.movementEnergy;
    const before = history.energies;
    const rank = before.length > 0 ? before.filter(e => e < energy).length / before.length : 0;
    history.energies.push(energy);
    if (before.length < MOMENTS.WARMUP_CYCLES || rank < MOMENTS.MIN_PERCENTILE) return;

    // The sound has to be music, loud enough to be heard from a pocket, without much voice
    const loud = audio && audio.musicDetected && audio.avgDb >= MOMENTS.MIN_DB && audio.vocalPresence <= MOMENTS.MAX_VOCAL
      && (audio.audioClassification === 'high_music' || audio.audioClassification === 'loud_music');
    if (!loud) return;
    if (c.cycleStartMs - history.lastKeptAt < MOMENTS.MIN_GAP_MS) return;

    // How good the moment is: intensity within the night, with a nudge for being in time
    const score = 0.7 * rank + 0.3 * (c.plv ?? c.tempoMatch ?? rank);
    let weakest: { id: string; score: number } | null = null;
    if (history.kept.length >= MOMENTS.MAX_PER_SESSION) {
      weakest = history.kept.reduce((a, b) => (a.score <= b.score ? a : b));
      if (score <= weakest.score + 0.02) return;
    }

    capturing = true;
    try {
      const end = Math.min(Date.now(), c.cycleStartMs + 10_000);
      const recent = await readRange(end - MOMENTS.CLIP_SECONDS * 1000, end);
      if (!recent || recent.count < SAMPLE_RATE * 10) return;
      await ensureDir();
      const id = Crypto.randomUUID();
      const rawPath = `${DIR}${id}-raw.wav`;
      await writeWav(rawPath, decodePcm(recent.pcm));
      const now = Date.now();
      await saveMoment({
        id, sessionId: session.id, startedAt: recent.startMs, durationMs: Math.round((recent.count / SAMPLE_RATE) * 1000), score,
        songIsrc: audio?.recognizedIsrc ?? null, songTitle: audio?.recognizedTitle ?? null, songArtist: audio?.recognizedArtist ?? null,
        bassShare: null, rustleShare: null, avgDb: audio?.avgDb ?? null, eventCode: session.eventCode ?? null,
        venuePlaceId: session.venuePlaceId ?? null, rawPath, cleanPath: null, createdAt: now, expiresAt: now + MOMENTS.RETAIN_DAYS * DAY_MS, sharedAt: null,
      });
      history.kept.push({ id, score });
      history.lastKeptAt = c.cycleStartMs;
      if (weakest) {
        history.kept = history.kept.filter(k => k.id !== weakest!.id);
        await this.deleteMoment(weakest.id).catch(() => {});
      }
      console.log(`${LOG_TAG} Kept a moment (score ${score.toFixed(2)})`);
    } catch (err) {
      console.warn(`${LOG_TAG} Could not keep a moment:`, err);
    } finally {
      capturing = false;
    }
  }

  /** At the start of a session: a fresh history. */
  resetSession(): void {
    history = null;
  }

  /**
   * Cleans new clips (and drops the ones that turn out not to be music-led), sends them if the
   * person opted in, and removes expired ones. Safe to call often; one run at a time.
   */
  async processPending(): Promise<void> {
    if (processing || Platform.OS !== 'ios') return;
    processing = true;
    try {
      await getMomentSettings();
      await this.sweepExpired();
      for (const m of await getUnprocessedMoments()) {
        try {
          const raw = await readWavSamples(m.rawPath);
          const { pcm, dominance } = await processClip(raw, SAMPLE_RATE, { yielder: macroYield });
          if (dominance.bassShare < MOMENTS.MIN_BASS_SHARE || dominance.rustleShare > MOMENTS.MAX_RUSTLE_SHARE) {
            console.log(`${LOG_TAG} Dropped a clip that is not music-led (bass ${dominance.bassShare.toFixed(2)}, rustle ${dominance.rustleShare.toFixed(2)})`);
            await this.deleteMoment(m.id);
            continue;
          }
          const cleanPath = `${DIR}${m.id}-clean.wav`;
          await writeWav(cleanPath, pcm);
          await updateMomentAnalysis(m.id, { cleanPath, bassShare: dominance.bassShare, rustleShare: dominance.rustleShare });
        } catch (err) {
          console.warn(`${LOG_TAG} Cleaning failed for a clip:`, err);
          // Keep the raw clip; it is retried next time, and not sent without its analysis
        }
      }
      if (momentsEnabled().share) await this.uploadPending();
    } finally {
      processing = false;
    }
  }

  private async uploadPending(): Promise<void> {
    const deviceId = await getDeviceId();
    for (const m of await getMomentsToShare()) {
      if (!m.cleanPath) continue; // wait for the analysis
      try {
        const base: Record<string, string> = {
          action: 'upload', device: deviceId, id: m.id, started: String(m.startedAt), dur: String(m.durationMs),
          session: m.sessionId,
        };
        const meta: Record<string, string> = { ...base, layer: 'raw' };
        if (m.eventCode) meta.event = m.eventCode;
        if (m.venuePlaceId) meta.venue = m.venuePlaceId;
        if (m.songIsrc) meta.isrc = m.songIsrc;
        meta.score = m.score.toFixed(3);
        if (m.bassShare != null) meta.bass = m.bassShare.toFixed(3);
        if (m.rustleShare != null) meta.rustle = m.rustleShare.toFixed(3);
        if (m.avgDb != null) meta.db = m.avgDb.toFixed(1);
        await momentsCall(meta, m.rawPath);
        await momentsCall({ ...base, layer: 'clean' }, m.cleanPath);
        await markMomentShared(m.id);
        console.log(`${LOG_TAG} Sent a moment`);
      } catch (err) {
        console.warn(`${LOG_TAG} Upload failed, will retry:`, err);
        return; // offline or the server is busy: try again next time
      }
    }
  }

  /** One moment: files, row, and the copy on the server if it was sent. Throws if the server delete fails. */
  async deleteMoment(id: string): Promise<void> {
    const m = await getMoment(id);
    if (!m) return;
    if (m.sharedAt != null) await momentsCall({ action: 'delete', device: await getDeviceId(), id });
    await removeFiles(m);
    await deleteMomentRow(id);
    if (history) history.kept = history.kept.filter(k => k.id !== id);
  }

  /** A session's moments (when the session is deleted); the server copies go first. */
  async deleteSessionMoments(sessionId: string): Promise<void> {
    const rows = await getSessionMoments(sessionId);
    if (rows.length === 0) return;
    if (rows.some(m => m.sharedAt != null)) await momentsCall({ action: 'delete', device: await getDeviceId(), session: sessionId });
    for (const m of rows) { await removeFiles(m); await deleteMomentRow(m.id); }
  }

  /**
   * Every moment of this phone, on the phone and on the server ("Delete my data", opting out).
   * `strict`: throw, deleting nothing, if the server can't be reached.
   */
  async deleteAll(strict = true): Promise<void> {
    try {
      await momentsCall({ action: 'delete', device: await getDeviceId(), all: '1' });
    } catch (err) {
      if (strict) throw err;
    }
    await FileSystem.deleteAsync(DIR, { idempotent: true }).catch(() => {});
    history = null;
  }

  private async sweepExpired(): Promise<void> {
    for (const m of await getExpiredMoments(Date.now())) {
      await this.deleteMoment(m.id).catch(async () => {
        // Offline: the server copy expires there by itself; remove the phone's now
        await removeFiles(m);
        await deleteMomentRow(m.id);
      });
    }
  }
}

export const momentKeeper = new MomentKeeper();
