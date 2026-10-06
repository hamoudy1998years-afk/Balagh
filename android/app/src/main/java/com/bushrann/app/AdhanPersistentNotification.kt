package com.bushrann.app

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

object AdhanPersistentNotification {

    const val CHANNEL_ID = "prayer-persistent-v3"
    const val NOTIFICATION_ID = 1002
    private const val REQUEST_CODE_OFFSET = 50000
    private val PRAYERS = arrayOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")
    private val DISPLAY_ORDER = arrayOf("Fajr", "Sunrise", "Dhuhr", "Asr", "Maghrib", "Isha")

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Prayer Times (Persistent)",
                NotificationManager.IMPORTANCE_MAX  // Only for persistent
            ).apply {
                description = "Always-on prayer times notification"
                setShowBadge(false)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.deleteNotificationChannel("prayer-persistent") // remove legacy v1 channel from older installs
            nm.createNotificationChannel(channel)
        }
    }

    private fun formatTime(time: String): String {
        // Times may carry a TZ suffix ("04:30 (PST)") — strip it before parsing
        val parts = time.split(" ")[0].split(":")
        if (parts.size != 2) return time
        val h = parts[0].toIntOrNull() ?: return time
        val m = parts[1].toIntOrNull() ?: return time
        val ampm = if (h < 12) "AM" else "PM"
        val h12 = when {
            h == 0 -> 12
            h > 12 -> h - 12
            else -> h
        }
        return String.format(Locale.US, "%d:%02d %s", h12, m, ampm)
    }

    private fun nextPrayer(timings: Map<String, String>): Pair<String, String>? {
        val now = Calendar.getInstance()
        val nowMinutes = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        for (prayer in PRAYERS) {
            val t = timings[prayer] ?: continue
            // Times may carry a TZ suffix ("05:12 (UTC+03:00)") — strip it
            val parts = t.split(" ")[0].split(":")
            if (parts.size != 2) continue
            val h = parts[0].toIntOrNull() ?: continue
            val m = parts[1].toIntOrNull() ?: continue
            if (h * 60 + m > nowMinutes) return prayer to t
        }
        val fajr = timings["Fajr"] ?: return null
        return "Fajr" to fajr
    }

    private fun buildLines(timings: Map<String, String>): String {
        val next = nextPrayer(timings)?.first
        val now = Calendar.getInstance()
        val nowMinutes = now.get(Calendar.HOUR_OF_DAY) * 60 + now.get(Calendar.MINUTE)
        val sb = StringBuilder()
        for (prayer in DISPLAY_ORDER) {
            val t = timings[prayer] ?: continue
            val status = when {
                prayer == "Sunrise" -> "🌄"
                prayer == next -> "⏰"
                else -> {
                    val parts = t.split(" ")[0].split(":")
                    val mins = (parts[0].toIntOrNull() ?: 0) * 60 + (parts[1].toIntOrNull() ?: 0)
                    if (mins <= nowMinutes) "✅" else "🔲"
                }
            }
            sb.append("$status $prayer: ${formatTime(t)}\n")
        }
        return sb.toString().trim()
    }

    // Today's entry from the per-date daily_timings store, falling back to the
    // flat prayer_timings when there is no dated entry for today.
    private fun todaysTimings(prefs: AdhanPreferences): Map<String, String>? {
        val todayKey = SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Date())
        val daily = prefs.getDailyTimings()
        val todays = daily?.get(todayKey)
        if (todays != null) return todays
        return prefs.getTimings()
    }

    fun post(context: Context) {
        val prefs = AdhanPreferences(context)
        if (!prefs.areNotificationsEnabled()) return
        val timings = todaysTimings(prefs) ?: return
        ensureChannel(context)

        val next = nextPrayer(timings)
        val title = if (next != null) "🕌 Next: ${next.first} at ${formatTime(next.second)}" else "🕌 Prayer Times"
        val lines = buildLines(timings)

        val openIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val openPending = PendingIntent.getActivity(
            context, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(lines)
            .setStyle(NotificationCompat.BigTextStyle().bigText(lines))
            .setSmallIcon(R.mipmap.ic_launcher)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openPending)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setLocalOnly(true)
            .setShowWhen(false)
            .setGroupSummary(true)
            .build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)
    }

    fun isShowing(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            for (n in nm.activeNotifications) {
                if (n.id == NOTIFICATION_ID) return true
            }
            return false
        }
        return true
    }

    fun repostIfDismissed(context: Context) {
        if (!isShowing(context)) {
            post(context)
        }
    }

    // Cancels any refresh alarms we may have scheduled before, across a wide
    // day range, so stale alarms from old app versions (different day-range /
    // offset formulas) don't pile up forever and hit Android's 500-alarm cap.
    private fun cancelRefreshAlarms(context: Context) {
        try {
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            for (dayOffset in 0..60) {
                for (prayer in PRAYERS) {
                    val intent = Intent(context, AdhanPersistentRefreshReceiver::class.java)
                    val requestCode = prayer.hashCode() + dayOffset + REQUEST_CODE_OFFSET
                    val pendingIntent = PendingIntent.getBroadcast(
                        context, requestCode, intent,
                        PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                    )
                    if (pendingIntent != null) {
                        alarmManager.cancel(pendingIntent)
                        pendingIntent.cancel()
                    }
                }
            }
        } catch (e: Exception) {
            // non-fatal, just means cleanup was incomplete
        }
    }

    fun scheduleRefreshAlarms(context: Context) {
        try {
            val prefs = AdhanPreferences(context)
            if (!prefs.areNotificationsEnabled()) return
            val prayerPrefs = prefs.getPrayerPrefs()
            val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager

            cancelRefreshAlarms(context)

            // Per-date actual times from daily_timings, covering the full stored
            // window (today + ~30 days). Falls back to the flat today-times 7-day
            // replay only when no dated data exists (older app versions).
            val dateFmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
            val daily = prefs.getDailyTimings()
            val todayCal = Calendar.getInstance().apply {
                set(Calendar.HOUR_OF_DAY, 0)
                set(Calendar.MINUTE, 0)
                set(Calendar.SECOND, 0)
                set(Calendar.MILLISECOND, 0)
            }
            if (daily != null && daily.isNotEmpty()) {
                for ((dateKey, timings) in daily) {
                    val date = dateFmt.parse(dateKey) ?: continue
                    // Calendar-day difference, not elapsed ms: each add(DAY_OF_YEAR, 1)
                    // moves exactly one local calendar day, so 23h/25h DST days count once.
                    val target = Calendar.getInstance().apply {
                        time = date
                        set(Calendar.HOUR_OF_DAY, 0)
                        set(Calendar.MINUTE, 0)
                        set(Calendar.SECOND, 0)
                        set(Calendar.MILLISECOND, 0)
                    }
                    var dayOffset = 0
                    while (target.after(todayCal)) {
                        target.add(Calendar.DAY_OF_YEAR, -1)
                        dayOffset++
                    }
                    while (target.before(todayCal)) {
                        target.add(Calendar.DAY_OF_YEAR, 1)
                        dayOffset--
                    }
                    if (dayOffset < 0) continue // past date — its refresh times are past anyway
                    for (prayer in PRAYERS) {
                        if (prayerPrefs?.get(prayer) == false) continue
                        val time = timings[prayer] ?: continue
                        // Times may carry a TZ suffix ("05:12 (UTC+03:00)") — strip it
                        val parts = time.split(" ")[0].split(":")
                        if (parts.size != 2) continue
                        val hours = parts[0].toIntOrNull() ?: continue
                        val minutes = parts[1].toIntOrNull() ?: continue
                        if (!scheduleRefresh(context, alarmManager, prayer, dayOffset, hours, minutes)) return
                    }
                }
                return
            }

            val timings = prefs.getTimings() ?: return
            // No per-date data available — replay today's flat times for the
            // coming week (the weekly reschedule keeps this topped up).
            for (dayOffset in 0..6) {
                for (prayer in PRAYERS) {
                    if (prayerPrefs?.get(prayer) == false) continue
                    val time = timings[prayer] ?: continue
                    val parts = time.split(" ")[0].split(":")
                    if (parts.size != 2) continue
                    val hours = parts[0].toIntOrNull() ?: continue
                    val minutes = parts[1].toIntOrNull() ?: continue
                    if (!scheduleRefresh(context, alarmManager, prayer, dayOffset, hours, minutes)) return
                }
            }
        } catch (e: Exception) {
            // never let this crash the calling receiver/module
        }
    }

    private fun scheduleRefresh(
        context: Context,
        alarmManager: AlarmManager,
        prayer: String,
        dayOffset: Int,
        hours: Int,
        minutes: Int
    ): Boolean {
        val intent = Intent(context, AdhanPersistentRefreshReceiver::class.java)
        val requestCode = prayer.hashCode() + dayOffset + REQUEST_CODE_OFFSET
        val pendingIntent = PendingIntent.getBroadcast(
            context, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // 30 minutes BEFORE the prayer
        val calendar = Calendar.getInstance().apply {
            add(Calendar.DAY_OF_YEAR, dayOffset)
            set(Calendar.HOUR_OF_DAY, hours)
            set(Calendar.MINUTE, minutes)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
            add(Calendar.MINUTE, -30)
        }

        if (calendar.timeInMillis <= System.currentTimeMillis()) return true

        try {
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
        } catch (e: SecurityException) {
            // permission revoked, skip
        } catch (e: IllegalStateException) {
            // hit Android's alarm cap — stop trying to schedule more this pass
            return false
        }
        return true
    }

    fun cancel(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(NOTIFICATION_ID)
    }
}