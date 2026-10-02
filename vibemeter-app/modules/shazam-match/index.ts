import { requireOptionalNativeModule } from 'expo';

export interface ShazamMatchResult {
  matched: boolean;
  title?: string | null;
  artist?: string | null;
  isrc?: string | null;
  genres?: string[];
  appleMusicID?: string | null;
  error?: string;
}

interface ShazamMatchNative {
  matchFile(uri: string): Promise<ShazamMatchResult>;
}

// Null on Android and on builds made before this module existed.
const native = requireOptionalNativeModule<ShazamMatchNative>('ShazamMatch');

export const isShazamAvailable = native != null;

/** Match a recorded audio file (file:// URI) with ShazamKit. Returns null when unavailable. */
export async function matchFile(uri: string): Promise<ShazamMatchResult | null> {
  if (!native) return null;
  return native.matchFile(uri);
}
