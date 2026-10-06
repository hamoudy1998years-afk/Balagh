package com.bushrann.app

import android.app.ForegroundServiceStartNotAllowedException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import java.util.Calendar

class AdhanAlarmReceiver : BroadcastReceiver() {
    // Alarms delivered more than this long after their scheduled instant are
    // ignored entirely (no service, no vibration, no notifications) — some
    // OEMs deliver exact alarms hours late, which must not play the Adhan.
    private val STALE_ALARM_TOLERANCE_MS = 15 * 60 * 1000L

    override fun onReceive(context: Context, intent: Intent) {
        AdhanDiagnostics.init(context)

        // Diagnostic first, before anything can return: receiver timestamp vs
        // intended scheduled instant (negative diff = EARLY delivery).
        val receiverMs = System.currentTimeMillis()
        val rawScheduled = intent.getLongExtra("scheduledTimeMillis", -1L)

        // Resolve the original armed timestamp. Alarms armed by older app
        // versions lack "scheduledTimeMillis" — fall back to reconstructing
        // today's HH:MM from the prayer extras and apply the same check.
        val scheduledTimeMillis = rawScheduled.let {
            if (it > 0) it else {
                val hours = intent.getIntExtra("hours", -1)
                val minutes = intent.getIntExtra("minutes", -1)
                if (hours < 0 || minutes < 0) -1L else Calendar.getInstance().apply {
                    set(Calendar.HOUR_OF_DAY, hours)
                    set(Calendar.MINUTE, minutes)
                    set(Calendar.SECOND, 0)
                    set(Calendar.MILLISECOND, 0)
                }.timeInMillis
            }
        }
        AdhanDiagnostics.log("RECEIVER_FIRED",
            mapOf(
                "prayer" to intent.getStringExtra("prayer"),
                "requestCode" to intent.getIntExtra("requestCode", -1),
                "scheduledFromExtra" to (rawScheduled > 0),
                "canScheduleExact" to AdhanDiagnostics.canScheduleExact(context)
            ) + AdhanDiagnostics.diffFields(receiverMs, scheduledTimeMillis)
        )
        if (scheduledTimeMillis > 0) {
            val lateMs = receiverMs - scheduledTimeMillis
            // Only reject lateness well beyond the tolerance — slightly early
            // or on-time deliveries always play.
            if (lateMs > STALE_ALARM_TOLERANCE_MS) {
                AdhanDiagnostics.log("STALE_REJECTED",
                    mapOf("prayer" to intent.getStringExtra("prayer")) +
                        AdhanDiagnostics.diffFields(receiverMs, scheduledTimeMillis)
                )
                return
            }
        }

        val prayer = intent.getStringExtra("prayer") ?: return
        val hours = intent.getIntExtra("hours", 0)
        val minutes = intent.getIntExtra("minutes", 0)
        
        val styleIndex = intent.getIntExtra("styleIndex", 0)
        val serviceIntent = Intent(context, AdhanForegroundService::class.java).apply {
            putExtra("prayer", prayer)
            putExtra("hours", hours)
            putExtra("minutes", minutes)
            putExtra("styleIndex", styleIndex)
        }
        
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent)
            } else {
                context.startService(serviceIntent)
            }
        } catch (e: Exception) {
            val blocked = Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
                (e is ForegroundServiceStartNotAllowedException ||
                 e.message?.contains("not allowed to start") == true)
            if (blocked) {
                // Android 15+ blocked FGS start (e.g. right after boot) — fall back
                // to a notification-driven Adhan instead of dropping it silently.
                AdhanNotificationHelper.postAdhanNotification(
                    context, prayer, hours, minutes, styleIndex
                )
            } else {
                e.printStackTrace()
            }
        }

                // Prayer time reached — refresh the persistent notification content
        AdhanPersistentNotification.post(context)
        
        // Safety check: if alarms are stale (>21 days since last reschedule), 
        // reschedule next 30 days. This prevents Android 12+ from dropping 
        // alarms after 30 days if persistent notification refresh missed.
        val prefs = context.getSharedPreferences("adhan_refresh_prefs", Context.MODE_PRIVATE)
        val lastReschedule = prefs.getLong("last_reschedule_ms", 0)
        val now = System.currentTimeMillis()
        val threeWeeks = 21L * 24 * 60 * 60 * 1000
        
        if (now - lastReschedule > threeWeeks) {
            AdhanPersistentNotification.scheduleRefreshAlarms(context)
            prefs.edit().putLong("last_reschedule_ms", now).apply()
        }
    }
}