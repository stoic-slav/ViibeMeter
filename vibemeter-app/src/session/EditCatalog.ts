import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { supabase } from '../config/supabase';
import { loadEditCatalog, EditCatalogEntry, isAudioCaptureAvailable } from '../../modules/audio-capture';

/**
 * The DJ edit catalog (build 25; idea: docs/ideas/dj-fingerprints.md): ShazamKit fingerprints of
 * edits credited to a DJ, either taken during a set we know from the venue's lineup or registered
 * by the DJ (approved by us). Downloaded at most every REFRESH_MS, cached on the phone, and loaded
 * into ShazamKit so music Apple's catalog doesn't know can still be credited. iPhone only.
 */

const LOG_TAG = '[EditCatalog]';
const CACHE = `${FileSystem.documentDirectory}edit-catalog.json`;
const REFRESH_MS = 12 * 3600_000;

let loaded = false;
// Links per catalog entry (the edit's or the DJ's page), for crediting in the recap
let links = new Map<string, string>();

/** The link of a catalog entry, if its DJ gave one. */
export function getEditLink(id: string): string | null {
  return links.get(id) ?? null;
}

async function readCache(): Promise<{ fetchedAt: number; entries: EditCatalogEntry[] } | null> {
  try {
    const info = await FileSystem.getInfoAsync(CACHE);
    if (!info.exists) return null;
    return JSON.parse(await FileSystem.readAsStringAsync(CACHE));
  } catch {
    return null;
  }
}

/** Downloads the catalog when the cached copy is old, then loads it into ShazamKit (once per run). */
export async function refreshEditCatalog(force = false): Promise<void> {
  if (Platform.OS !== 'ios' || !isAudioCaptureAvailable) return;
  try {
    let cache = await readCache();
    if (force || !cache || Date.now() - cache.fetchedAt > REFRESH_MS) {
      const { data, error } = await supabase.rpc('edit_catalog');
      if (!error && Array.isArray(data)) {
        cache = { fetchedAt: Date.now(), entries: data.map((r: any) => ({ id: r.id, signature: r.signature, dj: r.dj, title: r.title, link: r.link ?? null })) };
        await FileSystem.writeAsStringAsync(CACHE, JSON.stringify(cache));
        loaded = false;
      }
    }
    if (cache) links = new Map(cache.entries.filter(e => e.link).map(e => [e.id, e.link!]));
    if (cache && !loaded) {
      const count = await loadEditCatalog(cache.entries);
      loaded = true;
      console.log(`${LOG_TAG} ${count} DJ edit references loaded`);
    }
  } catch (err) {
    console.warn(`${LOG_TAG} Could not refresh:`, err);
  }
}

/** After "Delete my data" (the catalog holds no personal data, but start clean). */
export async function clearEditCatalogCache(): Promise<void> {
  loaded = false;
  await FileSystem.deleteAsync(CACHE, { idempotent: true }).catch(() => {});
}
