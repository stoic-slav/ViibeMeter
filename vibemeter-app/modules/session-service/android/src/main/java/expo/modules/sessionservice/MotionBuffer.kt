package expo.modules.sessionservice

import android.os.SystemClock

/**
 * Last few seconds of motion readings, in memory only. Values are in the Android sensor
 * frame and units (m/s², rad/s); timestamps are wall-clock ms on the same clock as Date.now().
 */
object MotionBuffer {
  private const val KEEP_MS = 15_000L

  // Flat rows: [t, x, y, z] for accel and gyro, [t, ax, ay, az, gx, gy, gz] for linear + gravity
  private val accel = ArrayDeque<DoubleArray>()
  private val linear = ArrayDeque<DoubleArray>()
  private val gyro = ArrayDeque<DoubleArray>()
  private var gravity: FloatArray? = null

  /** Sensor event timestamps are elapsedRealtimeNanos; convert to the wall clock. */
  fun wallClockMs(eventNanos: Long): Double =
    System.currentTimeMillis() - (SystemClock.elapsedRealtimeNanos() - eventNanos) / 1_000_000.0

  @Synchronized
  fun clear() {
    accel.clear(); linear.clear(); gyro.clear(); gravity = null
  }

  @Synchronized
  fun setGravity(x: Float, y: Float, z: Float) {
    gravity = floatArrayOf(x, y, z)
  }

  @Synchronized
  fun addAccel(t: Double, x: Float, y: Float, z: Float) = push(accel, doubleArrayOf(t, x.toDouble(), y.toDouble(), z.toDouble()))

  @Synchronized
  fun addGyro(t: Double, x: Float, y: Float, z: Float) = push(gyro, doubleArrayOf(t, x.toDouble(), y.toDouble(), z.toDouble()))

  @Synchronized
  fun addLinear(t: Double, x: Float, y: Float, z: Float) {
    val g = gravity ?: return
    push(linear, doubleArrayOf(t, x.toDouble(), y.toDouble(), z.toDouble(), g[0].toDouble(), g[1].toDouble(), g[2].toDouble()))
  }

  private fun push(queue: ArrayDeque<DoubleArray>, row: DoubleArray) {
    queue.addLast(row)
    val cutoff = row[0] - KEEP_MS
    while (queue.isNotEmpty() && queue.first()[0] < cutoff) queue.removeFirst()
  }

  /** Readings from the last [seconds], each series flattened row by row. */
  @Synchronized
  fun read(seconds: Double): Map<String, List<Double>> {
    val since = System.currentTimeMillis() - seconds * 1000
    fun flatten(queue: ArrayDeque<DoubleArray>): List<Double> {
      val out = ArrayList<Double>()
      for (row in queue) if (row[0] >= since) row.forEach { out.add(it) }
      return out
    }
    return mapOf("accel" to flatten(accel), "linear" to flatten(linear), "gyro" to flatten(gyro))
  }
}
