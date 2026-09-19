package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.AlarmManager
import android.app.PendingIntent
import android.os.Build
import java.util.Calendar
import java.text.SimpleDateFormat
import java.util.Locale

class AdhanBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED &&
            intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) {
            return
        }

        // If exact alarm permission was revoked (can happen after updates),
        // alarms can't fire — warn the user instead of silently failing.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val am = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            if (!am.canScheduleExactAlarms()) {
                AdhanPermissionWarning.post(context)
                return
            }
        }

        val prefs = AdhanPreferences(context)

        // Only re-schedule if notifications are enabled
        if (!prefs.areNotificationsEnabled()) return

        // Flat current-day timings — kept for the persistent notification
        // only. Never used below to generate future-day adhan alarms.
        prefs.getTimings() ?: return
        val prayerPrefs = prefs.getPrayerPrefs() ?: return
        val styleIndex = prefs.getAdhanStyle()

        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        val prayers = arrayOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")

        // Per-date timings saved by schedulePrayerNotifications(), keyed by
        // "YYYY-MM-DD". Each entry restores its OWN date's prayer times —
        // reboot must not replay one day's times across future days.
        val dailyTimings = prefs.getDailyTimings()
        if (dailyTimings != null && dailyTimings.isNotEmpty()) {
            val dateFormat = SimpleDateFormat("yyyy-MM-dd", Locale.US)
            val todayMidnight = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }

            for ((dateStr, dayTimings) in dailyTimings) {
                val parsed = try { dateFormat.parse(dateStr) } catch (e: Exception) { null } ?: continue
                val entryMidnight = Calendar.getInstance().apply { time = parsed }

                // Days between the entry's actual calendar date and today.
                // Entries keep their real date, so a reboot days later still
                // maps each row to the correct future offset (or skips it).
                val dayOffset = Math.round(
                    (entryMidnight.timeInMillis - todayMidnight.timeInMillis) / (24f * 60f * 60f * 1000f)
                ).toInt()
                if (dayOffset < 0) continue // date already past — skip, never reschedule

                for (prayer in prayers) {
                    // Skip if prayer is disabled
                    if (prayerPrefs[prayer] == false) continue

                    val time = dayTimings[prayer] ?: continue
                    val parts = time.split(" ")[0].split(":")
                    if (parts.size != 2) continue
                    val hours = parts[0].toIntOrNull() ?: continue
                    val minutes = parts[1].toIntOrNull() ?: continue

                    val calendar = Calendar.getInstance().apply {
                        timeInMillis = entryMidnight.timeInMillis
                        set(Calendar.HOUR_OF_DAY, hours)
                        set(Calendar.MINUTE, minutes)
                        set(Calendar.SECOND, 0)
                        set(Calendar.MILLISECOND, 0)
                    }

                    // Entry for today whose time already passed: skip it.
                    // Never bump it to tomorrow — tomorrow has its own entry.
                    if (calendar.timeInMillis <= System.currentTimeMillis()) continue

                    val alarmIntent = Intent(context, AdhanAlarmReceiver::class.java).apply {
                        putExtra("prayer", prayer)
                        putExtra("hours", hours)
                        putExtra("minutes", minutes)
                        putExtra("styleIndex", styleIndex)
                    }

                    // Same request-code scheme as AdhanModule.scheduleAdhan()
                    val requestCode = prayer.hashCode() + dayOffset
                    val pendingIntent = PendingIntent.getBroadcast(
                        context,
                        requestCode,
                        alarmIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                        alarmManager.setExactAndAllowWhileIdle(
                            AlarmManager.RTC_WAKEUP,
                            calendar.timeInMillis,
                            pendingIntent
                        )
                    } else {
                        alarmManager.setExact(
                            AlarmManager.RTC_WAKEUP,
                            calendar.timeInMillis,
                            pendingIntent
                        )
                    }
                }
            }
        }
        // If no per-date data exists yet (e.g. right after updating the app,
        // before PrayerScreen has scheduled once), no future-day alarms are
        // restored here rather than replaying stale flat times.

        // Re-post persistent notification and re-schedule its refresh alarms
        AdhanPersistentNotification.post(context)
        AdhanPersistentNotification.scheduleRefreshAlarms(context)
    }
}
