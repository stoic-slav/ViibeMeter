import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { supabase } from '../config/supabase';
import { buildNightRecap, DjSet, NightRecap, RecapItem } from '../processing/NightRecap';
import {
  getSessions, getClipsForSession, getWindowsForSession, getNightSongs, getNightEdits,
  saveNightRecap, getNightRecap, saveSongFeedback,
} from '../storage/LocalBuffer';
import { getDeviceId } from '../storage/DeviceIdentity';
import { syncSessions, syncSongFeedback } from '../storage/SupabaseSync';

/**
 * "Your night in songs" (build 25; plan docs/plans/build-25-night-in-songs.md). Built on the phone
 * when a session ends, kept locally with the titles, shown on /recap, and announced by a local
 * notification at 12:00 the next day. 👍/👎 per entry is uploaded without titles.
 */

const LOG_TAG = '[NightRecap]';
const NOTIFICATION_PREFIX = 'night-recap-';
const REMINDER_HOUR = 12;

/** A recap as kept on the phone: entries carry a stable ID and the user's 👍/👎. */
export interface StoredRecap extends NightRecap {
  items: (RecapItem & { id: string; liked: boolean | null })[];
}

/** The lineup at the session's venue, from the server (none when offline or unknown). */
async function fetchSets(placeId: string | null, from: number, to: number): Promise<DjSet[]> {
  if (!placeId) return [];
  try {
    const { data, error } = await supabase.rpc('venue_sets_for', {
      p_place_id: placeId, p_from: new Date(from).toISOString(), p_to: new Date(to).toISOString(),
    });
    if (error || !Array.isArray(data)) return [];
    return data.map((r: any) => ({ djName: r.dj_name, djLink: r.dj_link ?? null, startsAt: Date.parse(r.starts_at), endsAt: Date.parse(r.ends_at) }));
  } catch {
    return [];
  }
}

/** Builds (or rebuilds) the session's recap from the phone's clips, windows and songs. */
export async function buildRecap(sessionId: string): Promise<StoredRecap | null> {
  const session = (await getSessions()).find((s: any) => s.id === sessionId);
  if (!session) return null;
  const [clipRows, windows, songs, edits] = await Promise.all([
    getClipsForSession(sessionId), getWindowsForSession(sessionId), getNightSongs(sessionId), getNightEdits(sessionId),
  ]);
  const byMinute = new Map<number, any>(windows.map((w: any) => [w.window_start as number, w]));
  const startedAt = session.started_at as number;
  const endedAt = (session.ended_at as number | null) ?? Date.now();
  // The venue: the session's, else the one most of its minutes were at
  const counts = new Map<string, number>();
  for (const w of windows) if (w.venue_place_id) counts.set(w.venue_place_id, (counts.get(w.venue_place_id) ?? 0) + 1);
  const placeId: string | null = session.venue_place_id ?? [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const recap = buildNightRecap({
    sessionId,
    venueName: session.venue_name ?? null,
    startedAt,
    endedAt,
    clips: clipRows.map(c => {
      // Per-minute context from the window: the song's tempo, and whether the minute was walking
      const w = byMinute.get(Math.floor(c.clip_start / 60_000) * 60_000);
      return {
        clipStart: c.clip_start, movementEnergy: c.movement_energy, beatPlv: c.beat_plv,
        movementBpm: c.movement_bpm ?? null, songBpm: w?.song_bpm ?? null,
        pulseClarity: w?.pulse_clarity ?? null, spectralFlux: w?.spectral_flux ?? null, subBass: w?.sub_bass_energy ?? null,
        songIsrc: c.song_isrc, phoneContext: c.phone_context, walking: w?.movement_classification === 'walking',
      };
    }),
    songs,
    musicMinutes: new Set(windows.filter(w => w.music_detected === 1).map(w => w.window_start as number)),
    sets: await fetchSets(placeId, startedAt, endedAt),
    edits,
  });
  const previous = await getNightRecap<StoredRecap>(sessionId);
  const stored: StoredRecap = {
    ...recap,
    items: recap.items.map(i => {
      // Keep the ID and answer of an entry that was already shown
      const same = previous?.items.find(p => p.kind === i.kind && p.isrc === i.isrc && p.startsAt === i.startsAt);
      return { ...i, id: same?.id ?? Crypto.randomUUID(), liked: same?.liked ?? null };
    }),
  };
  await saveNightRecap(sessionId, stored);
  console.log(`${LOG_TAG} ${stored.items.length} entries, ${stored.recognisedSongs} songs recognised`);
  return stored;
}

export async function getOrBuildRecap(sessionId: string): Promise<StoredRecap | null> {
  return (await getNightRecap<StoredRecap>(sessionId)) ?? buildRecap(sessionId);
}

/** At Stop: build the recap and, when it has entries, remind at 12:00 the next day. */
export async function onSessionFinished(sessionId: string, endedAt: Date): Promise<void> {
  try {
    const recap = await buildRecap(sessionId);
    if (!recap || recap.items.length === 0) return;
    const at = new Date(endedAt);
    at.setHours(REMINDER_HOUR, 0, 0, 0);
    // Ended before noon (a night out): today at 12:00; otherwise tomorrow
    if (at.getTime() - endedAt.getTime() < 30 * 60_000) at.setDate(at.getDate() + 1);
    const top = recap.items[0];
    await Notifications.scheduleNotificationAsync({
      identifier: `${NOTIFICATION_PREFIX}${sessionId}`,
      content: {
        title: 'Your night in songs 🎶',
        body: top.kind === 'song' && top.title
          ? `Your #1 was ${top.title}${top.artist ? ` by ${top.artist}` : ''}. See your top ${recap.items.length}.`
          : `See the ${recap.items.length} moments you moved to most.`,
        data: { type: 'night-recap', sessionId },
        sound: 'default',
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
    });
  } catch (err) {
    console.warn(`${LOG_TAG} Could not build the recap:`, err);
  }
}

/** Opens the recap from its notification. Call once at app start. */
export function setupRecapNotifications(): void {
  const open = (r: Notifications.NotificationResponse) => {
    if (!r.notification.request.identifier.startsWith(NOTIFICATION_PREFIX)) return;
    const sessionId = (r.notification.request.content.data as any)?.sessionId;
    if (!sessionId) return;
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
    setTimeout(() => router.push({ pathname: '/recap', params: { sessionId } }), 500);
  };
  Notifications.addNotificationResponseReceivedListener(open);
  Notifications.getLastNotificationResponseAsync().then(r => { if (r) open(r); }).catch(() => {});
}

/** 👍 or 👎 on an entry: kept in the recap and uploaded (no titles). */
export async function answerRecapItem(recap: StoredRecap, itemId: string, liked: boolean): Promise<StoredRecap> {
  const index = recap.items.findIndex(i => i.id === itemId);
  if (index < 0) return recap;
  const item = recap.items[index];
  const next: StoredRecap = { ...recap, items: recap.items.map(i => (i.id === itemId ? { ...i, liked } : i)) };
  await saveNightRecap(recap.sessionId, next);
  await saveSongFeedback({
    id: item.id, sessionId: recap.sessionId, deviceId: await getDeviceId(), kind: item.kind, isrc: item.isrc,
    startsAt: item.startsAt, endsAt: item.endsAt, rank: index + 1, score: item.score, liked, djName: item.djName,
    parts: item.parts ?? null,
  });
  syncSessions().then(() => syncSongFeedback()).catch(() => {});
  return next;
}
