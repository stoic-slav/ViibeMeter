import { requireOptionalNativeModule } from 'expo';

/** Flat rows from the native buffer: accel/gyro [t, x, y, z]…, linear [t, ax, ay, az, gx, gy, gz]… */
export interface NativeMotion {
  accel: number[];   // m/s², including gravity
  linear: number[];  // m/s² linear acceleration, then the gravity vector at that moment
  gyro: number[];    // rad/s
}

interface SessionServiceNative {
  start(title: string, body: string): void;
  stop(): void;
  isRunning(): boolean;
  readMotion(seconds: number): NativeMotion;
}

// Android only. Null on iOS and on builds made before this module existed.
const native = requireOptionalNativeModule<SessionServiceNative>('SessionService');

export const SESSION_TASK_NAME = 'ViibeMeterSession';
export const isSessionServiceAvailable = native != null;

let endTask: (() => void) | null = null;

/**
 * Headless JS task started by the foreground service. While it is pending, React Native keeps
 * JS timers running with the app in the background. It resolves when the session stops.
 */
export function sessionTask(): Promise<void> {
  return new Promise(resolve => {
    endTask = resolve;
  });
}

export function startSessionService(title: string, body: string): boolean {
  if (!native) return false;
  try {
    native.start(title, body);
    return true;
  } catch (err) {
    console.warn('[SessionService] Could not start the foreground service:', err);
    return false;
  }
}

export function stopSessionService(): void {
  endTask?.();
  endTask = null;
  try {
    native?.stop();
  } catch {}
}

export function isSessionServiceRunning(): boolean {
  return native?.isRunning() ?? false;
}

export function readNativeMotion(seconds: number): NativeMotion | null {
  return native ? native.readMotion(seconds) : null;
}
