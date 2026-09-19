package com.bushrann.app

import android.content.Context
import android.content.SharedPreferences
import org.json.JSONArray
import org.json.JSONObject

class AdhanPreferences(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    companion object {
        const val PREFS_NAME = "AdhanPrefs"
        const val KEY_TIMINGS = "prayer_timings"
        const val KEY_PREFS = "prayer_prefs"
        const val KEY_STYLE = "adhan_style"
        const val KEY_ENABLED = "notifications_enabled"
        // Per-date adhan timings saved by schedulePrayerNotifications():
        // JSON object keyed by "YYYY-MM-DD", each value a prayer -> "HH:MM" map.
        const val KEY_DAILY_TIMINGS = "daily_timings"
    }

    fun saveDailyTimings(json: String) {
        prefs.edit().putString(KEY_DAILY_TIMINGS, json).apply()
    }

    // Returns date ("YYYY-MM-DD") -> timings map, or null if never saved.
    fun getDailyTimings(): Map<String, Map<String, String>>? {
        val jsonStr = prefs.getString(KEY_DAILY_TIMINGS, null) ?: return null
        return try {
            val result = mutableMapOf<String, Map<String, String>>()
            val root = JSONObject(jsonStr)
            val dates = root.keys()
            while (dates.hasNext()) {
                val date = dates.next()
                val timingsObj = root.getJSONObject(date)
                val timings = mutableMapOf<String, String>()
                val keys = timingsObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    timings[key] = timingsObj.getString(key)
                }
                result[date] = timings
            }
            result
        } catch (e: Exception) {
            null
        }
    }

    fun saveTimings(timings: Map<String, String>) {
        val json = JSONObject()
        for ((key, value) in timings) {
            json.put(key, value)
        }
        prefs.edit().putString(KEY_TIMINGS, json.toString()).apply()
    }

    fun getTimings(): Map<String, String>? {
        val jsonStr = prefs.getString(KEY_TIMINGS, null) ?: return null
        val json = JSONObject(jsonStr)
        val map = mutableMapOf<String, String>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = json.getString(key)
        }
        return map
    }

    fun savePrayerPrefs(prayerPrefs: Map<String, Boolean>) {
        val json = JSONObject()
        for ((key, value) in prayerPrefs) {
            json.put(key, value)
        }
        prefs.edit().putString(KEY_PREFS, json.toString()).apply()
    }

    fun getPrayerPrefs(): Map<String, Boolean>? {
        val jsonStr = prefs.getString(KEY_PREFS, null) ?: return null
        val json = JSONObject(jsonStr)
        val map = mutableMapOf<String, Boolean>()
        val keys = json.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = json.getBoolean(key)
        }
        return map
    }

    fun saveAdhanStyle(styleIndex: Int) {
        prefs.edit().putInt(KEY_STYLE, styleIndex).apply()
    }

    fun getAdhanStyle(): Int {
        return prefs.getInt(KEY_STYLE, 0)
    }

    fun saveNotificationsEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_ENABLED, enabled).apply()
    }

    fun areNotificationsEnabled(): Boolean {
        return prefs.getBoolean(KEY_ENABLED, true)
    }

    fun clearAll() {
        prefs.edit().clear().apply()
    }
}
