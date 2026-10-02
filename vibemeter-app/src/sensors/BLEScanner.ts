import { Platform, PermissionsAndroid, Permission } from 'react-native';
import { SENSOR_CONFIG } from '../config/constants';
import { CrowdTrend } from '../types';

const LOG_TAG = '[BLEScanner]';

export interface BLEScanMetrics {
  bleDeviceCount: number;
  bleCountDelta: number;
  bleCountTrend: CrowdTrend;
}

export class BLEScanner {
  private previousCount: number | null = null;
  private bleManager: any = null;
  private initialized = false;
  private androidPermissionGranted: boolean | null = null;

  /**
   * Android needs runtime permission before scanning: BLUETOOTH_SCAN/CONNECT on Android 12+
   * (API 31), fine location on older versions. iOS prompts automatically on first scan.
   * Asked once per app run; if denied, BLE is treated as unavailable (not as 0 devices).
   */
  private async ensureAndroidPermission(): Promise<boolean> {
    if (Platform.OS !== 'android') return true;
    if (this.androidPermissionGranted != null) return this.androidPermissionGranted;
    try {
      const perms: Permission[] = Number(Platform.Version) >= 31
        ? [PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN, PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT]
        : [PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION];
      const result = await PermissionsAndroid.requestMultiple(perms);
      this.androidPermissionGranted = perms.every(p => result[p] === PermissionsAndroid.RESULTS.GRANTED);
    } catch (err) {
      console.warn(`${LOG_TAG} Android permission request failed:`, err);
      this.androidPermissionGranted = false;
    }
    if (!this.androidPermissionGranted) {
      console.warn(`${LOG_TAG} Bluetooth permission denied — crowd density disabled`);
    }
    return this.androidPermissionGranted;
  }

  private async getBleManager(): Promise<any | null> {
    if (this.bleManager) return this.bleManager;
    try {
      const { BleManager } = await import('react-native-ble-plx');
      this.bleManager = new BleManager();
      this.initialized = true;
      return this.bleManager;
    } catch (err) {
      console.error(`${LOG_TAG} Failed to initialize BleManager:`, err);
      return null;
    }
  }

  /**
   * Scan for BLE devices for BLE_SCAN_DURATION_MS, count unique devices.
   * PRIVACY: Only the count is retained. No device IDs, MAC addresses, or names are stored.
   */
  async scan(): Promise<BLEScanMetrics | null> {
    if (!(await this.ensureAndroidPermission())) return null;
    const manager = await this.getBleManager();
    if (!manager) return null;

    try {
      const deviceIds = new Set<string>();
      let scanFailed = false;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          manager.stopDeviceScan();
          resolve();
        }, SENSOR_CONFIG.BLE_SCAN_DURATION_MS);

        manager.startDeviceScan(null, { allowDuplicates: false }, (error: any, device: any) => {
          if (error) {
            console.warn(`${LOG_TAG} Scan error:`, error.message);
            scanFailed = true;
            clearTimeout(timeout);
            manager.stopDeviceScan();
            resolve(); // Don't reject — partial results are still useful
            return;
          }
          if (device?.id) {
            // We add the ID to count unique devices, then immediately forget it
            deviceIds.add(device.id);
          }
        });
      });

      const currentCount = deviceIds.size;
      // PRIVACY: deviceIds set is cleared here — we only keep the count
      deviceIds.clear();

      // A failed scan (Bluetooth off, permission revoked) is missing data, not an empty room
      if (scanFailed && currentCount === 0) return null;

      const delta = this.previousCount != null ? currentCount - this.previousCount : 0;
      const trend = this.computeTrend(delta);

      this.previousCount = currentCount;

      console.log(`${LOG_TAG} Scan complete: ${currentCount} devices, delta=${delta}, trend=${trend} [platform=${Platform.OS}]`);

      return { bleDeviceCount: currentCount, bleCountDelta: delta, bleCountTrend: trend };
    } catch (err) {
      console.error(`${LOG_TAG} Scan failed:`, err);
      return null;
    }
  }

  private computeTrend(delta: number): CrowdTrend {
    if (delta >= SENSOR_CONFIG.BLE_TREND_FILLING_DELTA) return 'filling';
    if (delta <= SENSOR_CONFIG.BLE_TREND_THINNING_DELTA) return 'thinning';
    if (this.previousCount != null) return 'stable';
    return 'unknown';
  }

  resetHistory(): void {
    this.previousCount = null;
  }

  destroy(): void {
    if (this.bleManager) {
      this.bleManager.stopDeviceScan();
      this.bleManager.destroy();
      this.bleManager = null;
    }
  }
}
