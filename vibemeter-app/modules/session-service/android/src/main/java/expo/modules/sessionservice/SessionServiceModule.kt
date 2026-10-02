package expo.modules.sessionservice

import android.content.Intent
import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SessionServiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SessionService")

    // Must be called while the app is in the foreground: Android refuses to start a
    // microphone foreground service from the background.
    Function("start") { title: String, body: String ->
      val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
      val intent = Intent(context, SessionForegroundService::class.java)
        .putExtra(SessionForegroundService.EXTRA_TITLE, title)
        .putExtra(SessionForegroundService.EXTRA_BODY, body)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }

    Function("stop") {
      appContext.reactContext?.let { context ->
        context.stopService(Intent(context, SessionForegroundService::class.java))
      }
      Unit
    }

    Function("isRunning") {
      SessionForegroundService.running
    }

    Function("readMotion") { seconds: Double ->
      MotionBuffer.read(seconds)
    }
  }
}
