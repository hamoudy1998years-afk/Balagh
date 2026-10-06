package com.bushrann.app

import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import org.json.JSONArray
import org.json.JSONObject
import java.util.TimeZone

/**
 * TEMPORARY diagnostic ring buffer for investigating early/late Adhan
 * delivery. Local only (SharedPreferences), bounded to [MAX_EVENTS],
 * never throws, and must never interfere with Adhan behavior.
 *
 * differenceMs = receiverTime - intendedScheduledTime
 *   < 0 -> delivered EARLY, 0 -> on time, > 0 -> delivered LATE.
 */
object AdhanDiagnostics {

    private const val PREFS_NAME = "adhan_diagnostics"
    private const val KEY_EVENTS = "events"
    const val MAX_EVENTS = 200

    @Volatile
    private var initialized = false
    private lateinit var appContext: Context

    fun init(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            appContext = context.applicationContext
            initialized = true
        }
    }

    fun log(event: String, fields: Map<String, Any?>) {
        try {
            if (!initialized) return
            val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val arr = try {
                JSONArray(prefs.getString(KEY_EVENTS, "[]"))
            } catch (e: Exception) {
                JSONArray()
            }
            val obj = JSONObject()
            obj.put("event", event)
            obj.put("ts", System.currentTimeMillis())
            obj.put("tsHuman", humanTime(System.currentTimeMillis()))
            obj.put("tz", TimeZone.getDefault().id)
            obj.put("tzOffsetMin", TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000)
            obj.put("bootCount", bootCount(appContext))
            obj.put("versionCode", versionCode(appContext))
            for ((k, v) in fields) {
                if (v != null) obj.put(k, v)
            }
            arr.put(obj)
            while (arr.length() > MAX_EVENTS) arr.remove(0)
            prefs.edit().putString(KEY_EVENTS, arr.toString()).apply()
        } catch (e: Exception) {
            // Diagnostics must never break Adhan.
        }
    }

    fun getLogs(): String {
        return try {
            if (!initialized) return "(diagnostics not initialized)"
            val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val raw = prefs.getString(KEY_EVENTS, "[]") ?: "[]"
            val arr = JSONArray(raw)
            val sb = StringBuilder()
            for (i in 0 until arr.length()) {
                sb.append(arr.getJSONObject(i).toString()).append('\n')
            }
            sb.toString().ifEmpty { "(no diagnostic events recorded yet)" }
        } catch (e: Exception) {
            "(failed to read diagnostics)"
        }
    }

    fun clear() {
        try {
            if (!initialized) return
            appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit().remove(KEY_EVENTS).apply()
        } catch (e: Exception) {
        }
    }

    /** receiverTime - intendedScheduledTime, with human-readable form. */
    fun diffFields(receiverMs: Long, intendedMs: Long): Map<String, Any?> {
        if (intendedMs <= 0) return emptyMap()
        val diff = receiverMs - intendedMs
        return mapOf(
            "intendedMs" to intendedMs,
            "intendedHuman" to humanTime(intendedMs),
            "receiverMs" to receiverMs,
            "receiverHuman" to humanTime(receiverMs),
            "differenceMs" to diff,
            "differenceSec" to diff / 1000.0,
            "differenceMin" to diff / 60000.0,
            "direction" to when {
                diff < 0 -> "EARLY"
                diff == 0L -> "ON_TIME"
                else -> "LATE"
            }
        )
    }

    fun humanTime(ms: Long): String {
        return try {
            val cal = java.util.Calendar.getInstance()
            cal.timeInMillis = ms
            String.format(
                java.util.Locale.US,
                "%04d-%02d-%02d %02d:%02d:%02d.%03d",
                cal.get(java.util.Calendar.YEAR),
                cal.get(java.util.Calendar.MONTH) + 1,
                cal.get(java.util.Calendar.DAY_OF_MONTH),
                cal.get(java.util.Calendar.HOUR_OF_DAY),
                cal.get(java.util.Calendar.MINUTE),
                cal.get(java.util.Calendar.SECOND),
                cal.get(java.util.Calendar.MILLISECOND)
            )
        } catch (e: Exception) {
            ms.toString()
        }
    }

    fun bootCount(context: Context): Int {
        return try {
            Settings.Global.getInt(context.contentResolver, Settings.Global.BOOT_COUNT)
        } catch (e: Exception) {
            -1
        }
    }

    fun versionCode(context: Context): Long {
        return try {
            val pi = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.packageManager.getPackageInfo(
                    context.packageName,
                    android.content.pm.PackageManager.PackageInfoFlags.of(0)
                )
            } else {
                @Suppress("DEPRECATION")
                context.packageManager.getPackageInfo(context.packageName, 0)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) pi.longVersionCode
            else @Suppress("DEPRECATION") pi.versionCode.toLong()
        } catch (e: Exception) {
            -1L
        }
    }

    fun canScheduleExact(context: Context): Boolean {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                val am = context.getSystemService(Context.ALARM_SERVICE) as android.app.AlarmManager
                am.canScheduleExactAlarms()
            } else true
        } catch (e: Exception) {
            false
        }
    }
}
