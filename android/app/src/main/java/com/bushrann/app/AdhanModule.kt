package com.bushrann.app

import android.app.AlarmManager
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.PowerManager
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.LifecycleEventListener
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject
import java.util.Calendar

class AdhanModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext), LifecycleEventListener {

    companion object {
        @Volatile
        var isAppInForeground: Boolean = false
    }

    init {
        reactContext.addLifecycleEventListener(this)
    }

    override fun onHostResume() {
        isAppInForeground = true
    }

    override fun onHostPause() {
        isAppInForeground = false
    }

    override fun onHostDestroy() {
        isAppInForeground = false
    }

    private val adhanPrefs = AdhanPreferences(reactApplicationContext)

override fun getName() = "AdhanModule"

    @ReactMethod
    fun scheduleAdhan(prayer: String, hours: Int, minutes: Int, dayOffset: Int, styleIndex: Int) {
        val context = reactApplicationContext
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        
        val intent = Intent(context, AdhanAlarmReceiver::class.java).apply {
            putExtra("prayer", prayer)
            putExtra("hours", hours)
            putExtra("minutes", minutes)
            putExtra("styleIndex", styleIndex)
        }
        
        val requestCode = prayer.hashCode() + dayOffset
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
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
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!alarmManager.canScheduleExactAlarms()) {
                return
            }
        }

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
        } catch (e: IllegalStateException) {
        }
    }

    @ReactMethod
    fun cancelAllAdhans() {
        val context = reactApplicationContext
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        
        for (prayer in arrayOf("Fajr", "Dhuhr", "Asr", "Maghrib", "Isha")) {
            for (dayOffset in 0..30) {
                val intent = Intent(context, AdhanAlarmReceiver::class.java)
                val requestCode = prayer.hashCode() + dayOffset
                val pendingIntent = PendingIntent.getBroadcast(
                    context,
                    requestCode,
                    intent,
                    PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE
                )
                if (pendingIntent != null) {
                    alarmManager.cancel(pendingIntent)
                    pendingIntent.cancel()
                }
            }
        }
    }

    @ReactMethod
    fun startAdhan(prayer: String, styleIndex: Int) {
        val context = reactApplicationContext
        val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        
        val intent = Intent(context, AdhanAlarmReceiver::class.java).apply {
            putExtra("prayer", prayer)
            putExtra("hours", 0)
            putExtra("minutes", 0)
            putExtra("styleIndex", styleIndex)
        }
        
        val requestCode = "test_adhan".hashCode()
        val pendingIntent = PendingIntent.getBroadcast(
            context,
            requestCode,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        
        // Schedule 5 seconds from now — survives app kill
        val triggerTime = System.currentTimeMillis() + 5000
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (!alarmManager.canScheduleExactAlarms()) {
                return
            }
        }

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                alarmManager.setExactAndAllowWhileIdle(
                    AlarmManager.RTC_WAKEUP,
                    triggerTime,
                    pendingIntent
                )
            } else {
                alarmManager.setExact(
                    AlarmManager.RTC_WAKEUP,
                    triggerTime,
                    pendingIntent
                )
            }
        } catch (e: SecurityException) {
        } catch (e: IllegalStateException) {
        }
    }

    @ReactMethod
    fun savePrayerData(timingsJson: String, prefsJson: String, styleIndex: Int, enabled: Boolean) {
        try {
            val timingsObj = JSONObject(timingsJson)
            val timingsMap = mutableMapOf<String, String>()
            val tKeys = timingsObj.keys()
            while (tKeys.hasNext()) {
                val key = tKeys.next()
                timingsMap[key] = timingsObj.getString(key)
            }
            adhanPrefs.saveTimings(timingsMap)

            val prefsObj = JSONObject(prefsJson)
            val prefsMap = mutableMapOf<String, Boolean>()
            val pKeys = prefsObj.keys()
            while (pKeys.hasNext()) {
                val key = pKeys.next()
                prefsMap[key] = prefsObj.getBoolean(key)
            }
            adhanPrefs.savePrayerPrefs(prefsMap)

            adhanPrefs.saveAdhanStyle(styleIndex)
            adhanPrefs.saveNotificationsEnabled(enabled)

            // Timings changed — refresh persistent notification + its refresh alarms
            AdhanPersistentNotification.post(reactApplicationContext)
            AdhanPersistentNotification.scheduleRefreshAlarms(reactApplicationContext)
        } catch (e: Exception) {
            e.printStackTrace()
        }
    }

    @ReactMethod
    fun showPersistent() {
        AdhanPersistentNotification.post(reactApplicationContext)
    }

    @ReactMethod
    fun hidePersistent() {
        AdhanPersistentNotification.cancel(reactApplicationContext)
    }

    @ReactMethod
    fun canScheduleExactAlarms(promise: com.facebook.react.bridge.Promise) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val am = reactApplicationContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
            promise.resolve(am.canScheduleExactAlarms())
        } else {
            promise.resolve(true)
        }
    }

    @ReactMethod
    fun isBatteryOptIgnored(promise: com.facebook.react.bridge.Promise) {
        try {
            val pm = reactApplicationContext.getSystemService(Context.POWER_SERVICE) as PowerManager
            promise.resolve(pm.isIgnoringBatteryOptimizations(reactApplicationContext.packageName))
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }

    @ReactMethod
    fun isDndAccessGranted(promise: com.facebook.react.bridge.Promise) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val nm = reactApplicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                val channel = nm.getNotificationChannel(AdhanForegroundService.CHANNEL_ID)
                promise.resolve(channel?.canBypassDnd() == true)
            } else {
                promise.resolve(true)
            }
        } catch (e: Exception) {
            promise.resolve(false)
        }
    }
}






