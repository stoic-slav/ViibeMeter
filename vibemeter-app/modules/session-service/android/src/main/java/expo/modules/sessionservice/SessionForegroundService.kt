package expo.modules.sessionservice

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.util.Log
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Keeps a measuring session alive with the screen off.
 *
 * - Foreground service (microphone): Android only lets an app use the mic in the background
 *   while one is running, and shows its ongoing notification.
 * - Headless JS task: React Native pauses JS timers when the app leaves the foreground unless
 *   a headless task is active, which would stop the sensor loop.
 * - Motion sensors: expo-sensors stops listening when the activity goes to the background, so
 *   accelerometer, gravity, linear acceleration and gyroscope are recorded here instead, into
 *   a short in-memory buffer (MotionBuffer). Nothing is written to disk.
 */
class SessionForegroundService : HeadlessJsTaskService(), SensorEventListener {
  companion object {
    const val TASK_NAME = "ViibeMeterSession"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    private const val CHANNEL_ID = "viibemeter_session"
    private const val NOTIFICATION_ID = 4711
    private const val SAMPLING_PERIOD_US = 20_000 // 50 Hz
    private const val TAG = "SessionService"

    @Volatile
    var running = false
      private set
  }

  private var sensorManager: SensorManager? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (!enterForeground(intent)) {
      stopSelf()
      return START_NOT_STICKY
    }
    if (!running) {
      running = true
      MotionBuffer.clear()
      startSensors()
      startTask(HeadlessJsTaskConfig(TASK_NAME, Arguments.createMap(), 0, true))
    }
    // Not sticky: after a crash the JS session state is gone, so do not restart silently
    return START_NOT_STICKY
  }

  override fun onDestroy() {
    running = false
    sensorManager?.unregisterListener(this)
    sensorManager = null
    MotionBuffer.clear()
    super.onDestroy()
  }

  private fun enterForeground(intent: Intent?): Boolean {
    val notification = buildNotification(
      intent?.getStringExtra(EXTRA_TITLE) ?: "Viibe Check is measuring",
      intent?.getStringExtra(EXTRA_BODY) ?: "Session running. Open the app to stop it.",
    )
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        // Without the mic permission there is nothing to keep alive in the background
        if (!granted(Manifest.permission.RECORD_AUDIO)) return false
        startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
      } else {
        startForeground(NOTIFICATION_ID, notification)
      }
      true
    } catch (e: Exception) {
      Log.w(TAG, "Could not enter the foreground", e)
      false
    }
  }

  private fun granted(permission: String) =
    checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private fun buildNotification(title: String, body: String): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
      manager.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, "Measuring session", NotificationManager.IMPORTANCE_LOW).apply {
          description = "Shown while Viibe Check is measuring"
          setShowBadge(false)
        }
      )
    }
    val launch = packageManager.getLaunchIntentForPackage(packageName)
    val contentIntent = launch?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
    // expo-notifications generates a monochrome "notification_icon"; fall back to the app icon
    val icon = resources.getIdentifier("notification_icon", "drawable", packageName)
      .takeIf { it != 0 } ?: applicationInfo.icon

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION") Notification.Builder(this)
    }
    return builder
      .setContentTitle(title)
      .setContentText(body)
      .setSmallIcon(icon)
      .setOngoing(true)
      .setContentIntent(contentIntent)
      .build()
  }

  private fun startSensors() {
    val manager = getSystemService(SensorManager::class.java) ?: return
    sensorManager = manager
    val types = intArrayOf(
      Sensor.TYPE_ACCELEROMETER,
      Sensor.TYPE_LINEAR_ACCELERATION,
      Sensor.TYPE_GRAVITY,
      Sensor.TYPE_GYROSCOPE,
    )
    for (type in types) {
      manager.getDefaultSensor(type)?.let { manager.registerListener(this, it, SAMPLING_PERIOD_US) }
    }
  }

  override fun onSensorChanged(event: SensorEvent) {
    val v = event.values
    if (v.size < 3) return
    val t = MotionBuffer.wallClockMs(event.timestamp)
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> MotionBuffer.addAccel(t, v[0], v[1], v[2])
      Sensor.TYPE_GRAVITY -> MotionBuffer.setGravity(v[0], v[1], v[2])
      Sensor.TYPE_LINEAR_ACCELERATION -> MotionBuffer.addLinear(t, v[0], v[1], v[2])
      Sensor.TYPE_GYROSCOPE -> MotionBuffer.addGyro(t, v[0], v[1], v[2])
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
}
