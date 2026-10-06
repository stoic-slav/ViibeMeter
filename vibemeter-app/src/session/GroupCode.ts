import * as Crypto from 'expo-crypto';
import type { Venue } from './VenueLocator';

/**
 * Group codes put phones at the same event together for crowd sync, without anyone typing.
 * Every session gets a code automatically; friends join it by scanning its QR code (in-app
 * scanner, or the phone's Camera app via the vibemeter://join deep link). A shared code is a
 * definite "together" label. Phones that did not scan can still be grouped server-side from
 * the music they hear (analysis/auto_groups.py), and the codes are used to validate that.
 */

const CODE_PREFIX = 'G-';
// No 0/O/1/I so a code read aloud or typed is unambiguous
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateGroupCode(): string {
  const bytes = Crypto.getRandomBytes(6);
  let code = CODE_PREFIX;
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length];
  return code;
}

export function joinUrl(code: string): string {
  return `vibemeter://join?code=${encodeURIComponent(code)}`;
}

/**
 * A venue's QR code (printed by the venue, made on the venue-code screen). Scanning it confirms
 * the venue and joins that venue's crowd group for the night.
 */
export function venueJoinUrl(placeId: string, name: string): string {
  return `vibemeter://join?venue=${encodeURIComponent(placeId)}&name=${encodeURIComponent(name)}`;
}

export type ScanResult = { kind: 'group'; code: string } | { kind: 'venue'; placeId: string; name: string };

/** A scanned QR or opened link: a friend's group code, a venue code, or null for anything else. */
export function parseScan(data: string | null | undefined): ScanResult | null {
  if (!data) return null;
  const raw = data.trim();
  const venue = raw.match(/^vibemeter:\/\/join\?(.*)$/i);
  if (venue) {
    const params = new Map(venue[1].split('&').map(kv => {
      const [k, v = ''] = kv.split('=');
      return [k.toLowerCase(), safeDecode(v)] as [string, string];
    }));
    const placeId = params.get('venue');
    if (placeId && /^[A-Za-z0-9_-]{10,200}$/.test(placeId)) {
      return { kind: 'venue', placeId, name: (params.get('name') || 'Venue').slice(0, 80) };
    }
  }
  const code = parseGroupCode(raw, true);
  return code ? { kind: 'group', code } : null;
}

function safeDecode(v: string): string {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return v; }
}

/**
 * Tonight's crowd group at a venue: the same code for everyone who scans that venue's QR between
 * 06:00 and 06:00, a new one the next night. "V-" + 6 characters of SHA-256(place ID + night).
 */
export async function venueGroupCode(placeId: string, nightStartMs: number): Promise<string> {
  const night = new Date(nightStartMs);
  const day = `${night.getFullYear()}-${night.getMonth() + 1}-${night.getDate()}`;
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `${placeId}|${day}`);
  let code = 'V-';
  for (let i = 0; i < 6; i++) code += ALPHABET[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % ALPHABET.length];
  return code;
}

// The code this phone shows before its session starts, so friends can scan it first
let draftCode: string | null = null;
export function getDraftGroupCode(): string {
  if (!draftCode) draftCode = generateGroupCode();
  return draftCode;
}
/** Called once a session has used the draft code; the next session gets a new one. */
export function clearDraftGroupCode(): void {
  draftCode = null;
}

// A venue scanned (or opened via link) before the next session starts
let pendingVenue: Venue | null = null;
const venueListeners = new Set<(v: Venue | null) => void>();
export function setPendingVenue(v: Venue | null): void {
  pendingVenue = v;
  venueListeners.forEach(l => l(v));
}
export function getPendingVenue(): Venue | null {
  return pendingVenue;
}
export function onPendingVenue(listener: (v: Venue | null) => void): () => void {
  venueListeners.add(listener);
  return () => venueListeners.delete(listener);
}

/**
 * Accepts a join URL or a bare code. Returns a normalised code or null.
 * scanned: only accept a ViibeMeter join URL or a G- / V- code (a friend's group, or a venue's
 * crowd group shown by a friend), so an unrelated QR code (a menu, a Wi-Fi login) is not mistaken
 * for a group.
 */
export function parseGroupCode(data: string | null | undefined, scanned = false): string | null {
  if (!data) return null;
  let raw = data.trim();
  const m = raw.match(/^vibemeter:\/\/join\?(?:.*&)?code=([^&#]+)/i);
  if (m) raw = decodeURIComponent(m[1]);
  else if (/^[a-z]+:\/\//i.test(raw)) return null; // some other URL
  else if (scanned && !/^[GV]-/.test(raw.toUpperCase())) return null;
  const code = raw.toUpperCase().replace(/\s+/g, '');
  return /^[A-Z0-9-]{3,32}$/.test(code) ? code : null;
}

// A code joined (via deep link) before the next session starts
let pendingCode: string | null = null;
const listeners = new Set<(code: string | null) => void>();

export function setPendingGroupCode(code: string | null): void {
  pendingCode = code;
  listeners.forEach(l => l(code));
}

export function getPendingGroupCode(): string | null {
  return pendingCode;
}

export function onPendingGroupCode(listener: (code: string | null) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
