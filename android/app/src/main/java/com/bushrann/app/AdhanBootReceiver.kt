package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.app.AlarmManager
import android.app.PendingIntent
import android.os.Build
import java.util.Calendar

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
        
        val timings = prefs.getTimings() ?: return
        val prayerPrefs = prefs.getPrayerPrefs() ?: return
        val styleIndex = prefs.getAdhanStyle()
        
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        
        val prayers = arrayOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")
        
        for (dayOffset in 0..29) {
            for (prayer in prayers) {
                // Skip if prayer is disabled
                if (prayerPrefs[prayer] == false) continue
                
                val time = timings[prayer] ?: continue
                val parts = time.split(":")
                if (parts.size != 2) continue
                
                val hours = parts[0].toIntOrNull() ?: continue
                val minutes = parts[1].toIntOrNull() ?: continue
                
                val alarmIntent = Intent(context, AdhanAlarmReceiver::class.java).apply {
                    putExtra("prayer", prayer)
                    putExtra("hours", hours)
                    putExtra("minutes", minutes)
                    putExtra("styleIndex", styleIndex)
                }
                
                val requestCode = prayer.hashCode() + dayOffset
                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    requestCode,
                    alarmIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
                
                val calendar = Calendar.getInstance().apply {
                    add(Calendar.DAY_OF_YEAR, dayOffset)
                    set(Calendar.HOUR_OF_DAY, hours)
                    set(Calendar.MINUTE, minutes)
                    set(Calendar.SECOND, 0)
                    set(Calendar.MILLISECOND, 0)
                }
                
                if (calendar.timeInMillis <= System.currentTimeMillis()) {
                    calendar.add(Calendar.DAY_OF_YEAR, 1)
                }
                
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

        // Re-post persistent notification and re-schedule its refresh alarms
        AdhanPersistentNotification.post(context)
        AdhanPersistentNotification.scheduleRefreshAlarms(context)
    }
}
