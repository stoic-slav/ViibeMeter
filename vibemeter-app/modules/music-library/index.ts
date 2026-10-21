import { requireOptionalNativeModule } from 'expo';

export interface PlaylistResult {
  ok: boolean;
  reason?: 'unsupported' | 'denied' | 'no_subscription' | 'not_found' | 'error';
  added?: number;
  message?: string;
}

interface MusicLibraryNative {
  createPlaylist(name: string, description: string, appleMusicIds: string[], isrcs: string[]): Promise<PlaylistResult>;
}

// iOS only. Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<MusicLibraryNative>('ViibeMusicLibrary');

export const isMusicLibraryAvailable = native != null;

/** Creates an Apple Music playlist from the songs (Apple Music ID, else ISRC, per song). */
export async function createAppleMusicPlaylist(
  name: string, description: string, songs: { appleMusicId: string | null; isrc: string | null }[],
): Promise<PlaylistResult> {
  if (!native) return { ok: false, reason: 'unsupported' };
  try {
    return await native.createPlaylist(name, description, songs.map(s => s.appleMusicId ?? ''), songs.map(s => s.isrc ?? ''));
  } catch (err) {
    return { ok: false, reason: 'error', message: String(err) };
  }
}
