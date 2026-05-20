import * as Notifications from 'expo-notifications';
import * as Crypto from 'expo-crypto';
import { SubjectiveRating } from '../types';
import { SENSOR_CONFIG } from '../config/constants';
import { saveRating, getNearestWindowId, markRatingsSynced } from '../storage/LocalBuffer';
import { syncRatings } from '../storage/SupabaseSync';
import { getDeviceId } from '../storage/DeviceIdentity';

const LOG_TAG = '[VibePrompt]';
const NOTIFICATION_CHANNEL = 'vibe-prompt';
const NOTIFICATION_IDENTIFIER = 'vibe-check';

type PromptShownCallback = () => void;

export class VibePrompt {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private sessionId: string | null = null;
  private sessionStartTime: number | null = null;
  private lastPromptTime: number | null = null;
  private promptShownAt: number | null = null;
  private onPromptShown: PromptShownCallback | null = null;

  async setup(): Promise<void> {
    // Configure notification handler
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldShowBanner: true,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    // Create Android notification channel
    await Notifications.setNotificationChannelAsync(NOTIFICATION_CHANNEL, {
      name: 'Vibe Check',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250],
      lightColor: '#00FF88',
    });

    // Request permissions
    const { status } = await Notifications.requestPermissionsAsync();
    if (status !== 'granted') {
      console.warn(`${LOG_TAG} Notification permission not granted`);
    }
  }

  setPromptShownCallback(cb: PromptShownCallback): void {
    this.onPromptShown = cb;
  }

  startPromptSchedule(sessionId: string): void {
    this.sessionId = sessionId;
    this.sessionStartTime = Date.now();
    this.lastPromptTime = null;
    this.stopPromptSchedule();

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
    // Cancel any scheduled notifications
    Notifications.cancelScheduledNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
  }

  private async maybeShowPrompt(): Promise<void> {
    if (!this.sessionId || !this.sessionStartTime) return;

    const now = Date.now();

    // Don't prompt in first 5 minutes
    if (now - this.sessionStartTime < SENSOR_CONFIG.PROMPT_MIN_SESSION_MS) return;

    // Don't prompt if we just showed one recently
    if (this.lastPromptTime && now - this.lastPromptTime < SENSOR_CONFIG.PROMPT_INTERVAL_MS) return;

    await this.showPrompt();
  }

  async showPrompt(): Promise<void> {
    this.promptShownAt = Date.now();
    this.lastPromptTime = this.promptShownAt;

    // Schedule a local notification — tapping it opens the prompt screen
    await Notifications.scheduleNotificationAsync({
      identifier: NOTIFICATION_IDENTIFIER,
      content: {
        title: 'How\'s the vibe? 🎉',
        body: 'Tap to rate the vibe right now (2 seconds)',
        data: { type: 'vibe-check', sessionId: this.sessionId },
        categoryIdentifier: 'vibe-rating',
      },
      trigger: null, // Show immediately
    });

    if (this.onPromptShown) {
      this.onPromptShown();
    }

    console.log(`${LOG_TAG} Vibe prompt shown`);

    // Auto-dismiss after timeout
    setTimeout(() => {
      Notifications.dismissNotificationAsync(NOTIFICATION_IDENTIFIER).catch(() => {});
    }, SENSOR_CONFIG.PROMPT_TIMEOUT_MS);
  }

  async recordRating(
    rating: 1 | 2 | 3 | 4 | 5,
    musicRating: 1 | 2 | 3 | 4 | 5 | null = null,
    crowdRating: 1 | 2 | 3 | 4 | 5 | null = null,
  ): Promise<void> {
    if (!this.sessionId) {
      console.warn(`${LOG_TAG} No active session to record rating`);
      return;
    }

    const responseTimeMs = this.promptShownAt
      ? Date.now() - this.promptShownAt
      : 0;

    const ratedAt = new Date();
    const deviceId = await getDeviceId();
    const nearestWindowId = await getNearestWindowId(this.sessionId, ratedAt);

    const subjectiveRating: SubjectiveRating = {
      id: Crypto.randomUUID(),
      sessionId: this.sessionId,
      deviceId,
      rating,
      musicRating,
      crowdRating,
      ratedAt,
      nearestWindowId,
      responseTimeMs,
    };

    await saveRating(subjectiveRating);
    console.log(`${LOG_TAG} Rating recorded: ${rating}/5 in ${responseTimeMs}ms`);

    // Sync immediately — ratings are high-value data
    syncRatings().catch(err => console.error(`${LOG_TAG} Rating sync error:`, err));

    this.promptShownAt = null;
  }

  get isPromptActive(): boolean {
    return this.promptShownAt != null;
  }
}

export const vibePrompt = new VibePrompt();
