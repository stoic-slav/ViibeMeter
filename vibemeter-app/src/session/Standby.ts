import { Platform } from 'react-native';
import { Audio } from 'expo-av';
import * as Battery from 'expo-battery';
import * as Crypto from 'expo-crypto';
import * as Notifications from 'expo-notifications';
import { STANDBY } from '../config/constants';
import { StandbyEndReason, StandbyNight } from '../types';
import { sensorOrchestrator, StandbyCheck } from '../sensors/SensorOrchestrator';
import { sessionManager } from './SessionManager';
import { onSessionEnded, onSessionStarted, startSessionFromStandby } from './SessionControl';
import { isInVehicle } from '../../modules/audio-capture';
import { Minute, isMusicCheck, isMovingCheck, isNight, nextMorning, partyInWindow } from './StandbyRules';
import { getDeviceId } from '../storage/DeviceIdentity';
import { saveStandbyNight, closeOpenStandbyNights } from '../storage/LocalBuffer';
import { syncStandbyNights } from '../storage/SupabaseSync';
import { startStandbyCard, setStandbyCardMode, endCardNow, setCardActionHandler } from '../notifications/LockScreenCard';

/**
 * "Going out" standby (iOS, build 24; plan: docs/plans/build-24-going-out-standby.md).
 * Switched on once in the evening with the app open (iOS opens the microphone only then). The
 * phone then listens with a light check every 30 s, storing nothing, and asks "Start measuring?"
 * on the lock-screen card when it sounds AND moves like a party:
 * - a music minute: loud (≥ 75 dB) with a beat;
 * - a moving minute: on a body, more than walking or standing, with a rhythm (movement locked to
 *   the beat, matching its tempo, or clearly periodic);
 * - at least 5 music minutes and 2 moving minutes in the last 6, at night, not in a vehicle.
 * "Yes" starts a session right there, without unlocking. Only counts are kept (standby_nights).
 */

export type StandbyState = 'off' | 'standby' | 'prompt' | 'session';

const LOG_TAG = '[Standby]';
const MINUTE_MS = 60_000;
const NOTIFICATION_ID = 'standby-prompt';
const CATEGORY_ID = 'standby-prompt';
const ACTION_START = 'standby-start';
const ACTION_NOT_NOW = 'standby-not-now';

async function readBattery(): Promise<{ pct: number | null; low: boolean }> {
  try {
    const [level, state] = await Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]);
    const charging = state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL;
    const pct = level >= 0 && !charging ? Math.round(level * 1000) / 10 : null;
    return { pct, low: pct != null && pct <= STANDBY.LOW_BATTERY_PCT };
  } catch {
    return { pct: null, low: false };
  }
}

export class Standby {
  private state: StandbyState = 'off';
  private night: StandbyNight | null = null;
  private minutes = new Map<number, Minute>();
  private countedThrough = 0;          // minutes up to this one are in the night's counts
  private promptAt = 0;
  private lastPromptAt = 0;
  private checksSinceSave = 0;
  private listeners = new Set<(s: StandbyState) => void>();

  get current(): StandbyState { return this.state; }
  get armedAt(): number | null { return this.night?.armedAt ?? null; }

  /** Notifications, card buttons and session hooks. Call once at app start. */
  async setup(): Promise<void> {
    setCardActionHandler('start', () => { this.accept().catch(err => console.warn(`${LOG_TAG} Start failed:`, err)); });
    setCardActionHandler('not_now', () => this.notNow());
    setCardActionHandler('standby_off', () => { this.disarm('user').catch(() => {}); });

    onSessionStarted(() => {
      // A session started by hand while standing by: standby's job is done for this session
      if (this.state === 'standby' || this.state === 'prompt') this.setState('session');
    });
    onSessionEnded(() => {
      if (this.state === 'session') this.disarm('session_ended').catch(() => {});
    });

    if (Platform.OS !== 'ios') return;
    await Notifications.setNotificationCategoryAsync(CATEGORY_ID, [
      { identifier: ACTION_START, buttonTitle: '▶ Yes, start measuring', options: { opensAppToForeground: false } },
      { identifier: ACTION_NOT_NOW, buttonTitle: 'Not now', options: { opensAppToForeground: false } },
    ]).catch(err => console.warn(`${LOG_TAG} Could not register prompt buttons:`, err));
    Notifications.addNotificationResponseReceivedListener(r => {
      if (r.notification.request.identifier !== NOTIFICATION_ID) return;
      if (r.actionIdentifier === ACTION_NOT_NOW) this.notNow();
      // The Yes button, or a tap on the notification itself (which opens the app)
      else this.accept().catch(err => console.warn(`${LOG_TAG} Start failed:`, err));
    });

    // A standby the app never ended (it was killed) is closed as interrupted
    closeOpenStandbyNights(null, STANDBY.CHECK_INTERVAL_MS)
      .then(n => { if (n > 0) syncStandbyNights().catch(() => {}); })
      .catch(() => {});
  }

  onChange(listener: (s: StandbyState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private setState(s: StandbyState): void {
    this.state = s;
    this.listeners.forEach(l => l(s));
  }

  /**
   * Switch standby on. The app must be in the foreground (microphone and card start only then).
   * Returns why it could not start, or null.
   */
  async arm(): Promise<'unsupported' | 'session' | 'mic' | 'error' | null> {
    if (Platform.OS !== 'ios') return 'unsupported';
    if (this.state !== 'off') return null;
    if (sessionManager.isSessionActive) return 'session';
    const { granted } = await Audio.requestPermissionsAsync();
    if (!granted) return 'mic';
    const ok = await sensorOrchestrator.startStandby(check => this.onCheck(check));
    if (!ok) return 'error';

    const battery = await readBattery();
    this.night = {
      id: Crypto.randomUUID(),
      deviceId: await getDeviceId(),
      armedAt: Date.now(),
      endedAt: null,
      endReason: null,
      prompts: 0, accepted: 0, declined: 0, ignored: 0,
      checks: 0, musicMinutes: 0, movingMinutes: 0, partyMinutes: 0,
      batteryStartPct: battery.pct,
      batteryEndPct: null,
    };
    this.minutes.clear();
    this.countedThrough = Math.floor(Date.now() / MINUTE_MS) - 1;
    this.lastPromptAt = 0;
    this.checksSinceSave = 0;
    this.setState('standby');
    await startStandbyCard();
    await this.save(true);
    console.log(`${LOG_TAG} On`);
    return null;
  }

  async disarm(reason: StandbyEndReason): Promise<void> {
    if (this.state === 'off') return;
    const wasSession = this.state === 'session';
    this.setState('off');
    await sensorOrchestrator.stopStandby(false);
    // A session's card belongs to the session; a standby or prompt card goes now
    if (!wasSession) await endCardNow();
    Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
    // Deleting the user's data: nothing more is saved or uploaded (an upload could race the delete)
    if (this.night && reason !== 'deleted') {
      this.countMinutes(Number.MAX_SAFE_INTEGER);
      this.night.endedAt = Date.now();
      this.night.endReason = reason;
      this.night.batteryEndPct = (await readBattery()).pct;
      await this.save(true);
    }
    this.night = null;
    this.minutes.clear();
    console.log(`${LOG_TAG} Off (${reason})`);
  }

  /** "Yes, start measuring" (card, notification, or the app). */
  async accept(): Promise<void> {
    if (this.state !== 'prompt' && this.state !== 'standby') return;
    if (this.night && this.state === 'prompt') this.night.accepted++;
    Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
    this.setState('session');
    await this.save(true);
    await startSessionFromStandby();
    console.log(`${LOG_TAG} Session started from the prompt`);
  }

  /** "Not now": back to standing by, quiet for the cooldown. */
  notNow(): void {
    if (this.state !== 'prompt') return;
    if (this.night) this.night.declined++;
    this.backToStandby();
  }

  private backToStandby(): void {
    Notifications.dismissNotificationAsync(NOTIFICATION_ID).catch(() => {});
    this.setState('standby');
    setStandbyCardMode('standby');
    this.save(true).catch(() => {});
  }

  private onCheck(c: StandbyCheck): void {
    if (!this.night || (this.state !== 'standby' && this.state !== 'prompt')) return;
    const now = Date.now();
    this.night.checks++;

    // Ends by itself: at 06:00, after the maximum duration, or on a low battery
    if (now >= nextMorning(this.night.armedAt)) { this.disarm('morning').catch(() => {}); return; }
    if (now - this.night.armedAt >= STANDBY.MAX_DURATION_MS) { this.disarm('max_duration').catch(() => {}); return; }

    const minute = Math.floor(c.atMs / MINUTE_MS);
    const m = this.minutes.get(minute) ?? { music: false, moving: false };
    m.music = m.music || isMusicCheck(c);
    m.moving = m.moving || isMovingCheck(c);
    this.minutes.set(minute, m);
    this.countMinutes(minute - 1);
    for (const k of this.minutes.keys()) if (k <= minute - STANDBY.WINDOW_MINUTES) this.minutes.delete(k);

    if (this.state === 'prompt' && now - this.promptAt >= STANDBY.PROMPT_TIMEOUT_MS) {
      this.night.ignored++;
      this.backToStandby();
    } else if (this.state === 'standby' && this.partyNow(minute, now)) {
      this.maybePrompt().catch(err => console.warn(`${LOG_TAG} Prompt failed:`, err));
    }

    // Saved on the phone every check (so a killed app's evening keeps its length), uploaded and
    // battery-checked every SAVE_EVERY_CHECKS
    const upload = ++this.checksSinceSave >= STANDBY.SAVE_EVERY_CHECKS;
    if (upload) {
      this.checksSinceSave = 0;
      readBattery().then(b => {
        if (b.low && this.state !== 'off' && this.state !== 'session') this.disarm('low_battery').catch(() => {});
      });
    }
    this.save(upload).catch(() => {});
  }

  /** Enough music and moving minutes in the last WINDOW_MINUTES, at night, outside the cooldown. */
  private partyNow(minute: number, now: number): boolean {
    if (!isNight(now) || !this.night) return false;
    if (this.night.prompts >= STANDBY.MAX_PROMPTS_PER_NIGHT) return false;
    if (this.lastPromptAt && now - this.lastPromptAt < STANDBY.PROMPT_COOLDOWN_MS) return false;
    return partyInWindow(this.minutes, minute);
  }

  private async maybePrompt(): Promise<void> {
    // A car radio is not a party
    if (await isInVehicle()) return;
    if (!this.night || this.state !== 'standby') return;
    this.night.prompts++;
    this.promptAt = this.lastPromptAt = Date.now();
    this.setState('prompt');
    setStandbyCardMode('prompt');
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_ID,
      content: {
        title: 'Sounds like a party 🎶',
        body: 'Start measuring? Tap Yes here or on the lock-screen card.',
        categoryIdentifier: CATEGORY_ID,
        sound: 'default',
      },
      trigger: null,
    });
    await this.save(true);
    console.log(`${LOG_TAG} Prompted`);
  }

  /** Adds finished minutes up to `through` to the night's counts. */
  private countMinutes(through: number): void {
    if (!this.night) return;
    for (const [k, m] of [...this.minutes.entries()].sort((a, b) => a[0] - b[0])) {
      if (k <= this.countedThrough || k > through) continue;
      if (m.music) this.night.musicMinutes++;
      if (m.moving) this.night.movingMinutes++;
      if (m.music && m.moving) this.night.partyMinutes++;
      this.countedThrough = k;
    }
  }

  private async save(upload: boolean): Promise<void> {
    if (!this.night) return;
    await saveStandbyNight(this.night).catch(err => console.warn(`${LOG_TAG} Save failed:`, err));
    if (upload) syncStandbyNights().catch(() => {});
  }
}

// Singleton
export const standby = new Standby();
