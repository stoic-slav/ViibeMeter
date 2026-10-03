import * as Crypto from 'expo-crypto';

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
 * Accepts a join URL or a bare code. Returns a normalised code or null.
 * scanned: only accept a ViibeMeter join URL or a G- code, so an unrelated QR code (a menu,
 * a Wi-Fi login) is not mistaken for a group.
 */
export function parseGroupCode(data: string | null | undefined, scanned = false): string | null {
  if (!data) return null;
  let raw = data.trim();
  const m = raw.match(/^vibemeter:\/\/join\?(?:.*&)?code=([^&#]+)/i);
  if (m) raw = decodeURIComponent(m[1]);
  else if (/^[a-z]+:\/\//i.test(raw)) return null; // some other URL
  else if (scanned && !raw.toUpperCase().startsWith(CODE_PREFIX)) return null;
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
