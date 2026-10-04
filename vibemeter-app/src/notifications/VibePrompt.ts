import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import { RatingSource, SubjectiveRating } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { saveRating, getNearestWindowId } from '../storage/LocalBuffer';
import { syncRatings } from '../storage/SupabaseSync';
import { getDeviceId } from '../storage/DeviceIdentity';

const LOG_TAG = '[VibePrompt]';
// Android channel settings are fixed once created, so vibration needs a new channel id
const NOTIFICATION_CHANNEL = 'vibe-check';
const NOTIFICATION_IDENTIFIER = 'vibe-check';
const CATEGORY_ID = 'vibe-rating';

/**
 * The vibe rating: three levels, the same on iOS and Android, answerable straight from the
 * lock-screen notification. Stored as 1 / 3 / 5 so it fits the existing 1–5 column
 * (rating_scale = 3 marks these ratings).
 */
export const RATING_OPTIONS = [
  { id: 'rate-dead', emoji: '💀', label: 'Dead', value: 1 },
  { id: 'rate-decent', emoji: '🙂', label: 'Decent', value: 3 },
  { id: 'rate-best', emoji: '🔥', label: 'Best', value: 5 },
] as const;
export type RatingValue = typeof RATING_OPTIONS[number]['value'];

type Callback = () => void;

export class VibePrompt {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private sessionStartTime: number | null = null;
  private lastPromptTime: number | null = null;
  // Set while a prompt is unanswered; cleared by an answer or replaced by the next prompt
  private promptShownAt: number | null = null;
  private onPromptShown: Callback | null = null;
  private onPromptRequested: Callback | null = null;
  private onRated: Callback | null = null;
  private responseSub: { remove: () => void } | null = null;

  async setup(): Promise<void> {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
      }),
    });

    await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
      name: 'Vibe Check',
      importance: Notifications.AndroidImportance.HIGH,
      enableVibrate: true,
      vibrationPattern: [0, 400, 200, 400],
      sound: 'default',
      lightColor: '#00FF88',
    });
    Notifications.deleteNotificationChannelAsync('vibe-prompt').catch(() => {}); // old, silent

    // Rating buttons on the notification itself: long-press (iOS) or the buttons under it
    // (Android) rate without unlocking the phone or opening the app
    await Notifications.setNotificationCategoryAsync(
      CATEGORY_ID,
      RATING_OPTIONS.map(o => ({
        identifier: o.id,
        buttonTitle: `${o.emoji} ${o.label}`,
        options: { opensAppToForeground: false },
      })),
    ).catch(err => console.warn(`${LOG_TAG} Could not register rating buttons:`, err));

    this.responseSub?.remove();
    this.responseSub = Notifications.addNotificationResponseReceivedListener(r => this.handleResponse(r));
    // A tap that launched the app is delivered before the listener exists
    Notifications.getLastNotificationResponseAsync()
      .then(r => { if (r) this.handleResponse(r); })
      .catch(() => {});

    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn(`${LOG_TAG} Notification permission not granted`);
    }
  }

  /** The UI shows the rating sheet when a prompt fires (if the app is open)… */
  setPromptShownCallback(cb: Callback): void {
    this.onPromptShown = cb;
  }

  /** …and when the user taps the notification to open the app. */
  setPromptRequestedCallback(cb: Callback): void {
    this.onPromptRequested = cb;
  }

  /** Called after any rating is saved, so an open sheet can close. */
  setRatedCallback(cb: Callback): void {
    this.onRated = cb;
  }

  /** True while the latest prompt is unanswered. */
  get pendingPrompt(): boolean {
    return this.promptShownAt != null;
  }

  get isPromptActive(): boolean {
    return this.pendingPrompt;
  }

  /** Milliseconds until the next prompt, or null without a session. */
  get msUntilNextPrompt(): number | null {
    if (!this.sessionStartTime) return null;
    const base = this.lastPromptTime ?? this.sessionStartTime + SENSOR_CONFIG.PROMPT_MIN_SESSION_MS - SENSOR_CONFIG.PROMPT_INTERVAL_MS;
    return Math.max(0, base + SENSOR_CONFIG.PROMPT_INTERVAL_MS - Date.now());
  }

  startPromptSchedule(sessionId: string): void {
    this.stopPromptSchedule();
    this.sessionId = sessionId;
    this.sessionStartTime = Date.now();
    this.lastPromptTime = null;
    this.promptShownAt = null;

    this.intervalId = setInterval(() => {
      this.maybeShowPrompt();
    }, 60000); // Check every minute

    console.log(`${LOG_TAG} Prompt schedule started for session ${sessionId}`);
  }

  stopPromptSchedule(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.promptShownAt = null;
    this.sessionStartTime = null;
    Notifications.dismissNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
  }

  private async maybeShowPrompt(): Promise<void> {
    if (!this.sessionId || !this.sessionStartTime) return;
    const now = Date.now();
    if (now - this.sessionStartTime < SENSOR_CONFIG.PROMPT_MIN_SESSION_MS) return;
    if (this.lastPromptTime && now - this.lastPromptTime < SENSOR_CONFIG.PROMPT_INTERVAL_MS) return;
    await this.showPrompt();
  }

  async showPrompt(): Promise<void> {
    this.promptShownAt = Date.now();
    this.lastPromptTime = this.promptShownAt;

    // Same identifier: a new prompt replaces an unanswered one. It is not auto-dismissed, so a
    // phone locked in a pocket still has it when its owner looks.
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_IDENTIFIER,
      content: {
        title: "How's the vibe right now?",
        body: RATING_OPTIONS.map(o => `${o.emoji} ${o.label}`).join(' · '),
        data: { type: 'vibe-check', sessionId: this.sessionId },
        categoryIdentifier: CATEGORY_ID,
        // The prompt has to be noticed with the phone in a pocket: iOS vibrates with the sound
        // (and vibrates only in silent mode), Android uses the channel's vibration pattern
        sound: 'default',
      },
      trigger: { channelId: NOTIFICATION_CHANNEL }, // immediately, on the vibrating channel
    });

    this.onPromptShown?.();
    console.log(`${LOG_TAG} Vibe prompt shown`);
  }

  private handleResponse(response: Notifications.NotificationResponse): void {
    if (response.notification.request.identifier !== NOTIFICATION_IDENTIFIER) return;
    const option = RATING_OPTIONS.find(o => o.id === response.actionIdentifier);
    if (option) {
      this.recordRating(option.value, 'lockscreen')
        .catch(err => console.warn(`${LOG_TAG} Lock-screen rating failed:`, err));
      Notifications.dismissNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
    } else if (response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER && this.pendingPrompt) {
      // The notification itself was tapped: open the one-tap sheet
      this.onPromptRequested?.();
    }
  }

  async recordRating(rating: RatingValue, source: RatingSource): Promise<void> {
    if (!this.sessionId) {
      console.warn(`${LOG_TAG} No active session to record rating`);
      return;
    }

    const responseTimeMs = this.promptShownAt ? Date.now() - this.promptShownAt : 0;
    const ratedAt = new Date();
    const deviceId = await getDeviceId();
    const nearestWindowId = await getNearestWindowId(this.sessionId, ratedAt);

    const subjectiveRating: SubjectiveRating = {
      id: Crypto.randomUUID(),
      sessionId: this.sessionId,
      deviceId,
      rating,
      musicRating: null,
      crowdRating: null,
      ratedAt,
      nearestWindowId,
      responseTimeMs,
      ratingScale: 3,
      ratingSource: source,
    };

    this.promptShownAt = null;
    await saveRating(subjectiveRating);
    console.log(`${LOG_TAG} Rating recorded: ${rating} (${source}) after ${responseTimeMs}ms`);
    Notifications.dismissNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
    this.onRated?.();

    // Sync immediately — ratings are high-value data
    syncRatings().catch(err => console.error(`${LOG_TAG} Rating sync error:`, err));
  }

  /** Dismiss the current prompt without rating. */
  skipPrompt(): void {
    this.promptShownAt = null;
    Notifications.dismissNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
  }
}

export const vibePrompt = new VibePrompt();
