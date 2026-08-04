package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

class AdhanPersistentRefreshReceiver : BroadcastReceiver() {
    
    companion object {
        private const val PREFS_NAME = "adhan_refresh_prefs"
        private const val LAST_RESCHEDULE_KEY = "last_reschedule_ms"
        private const val WEEK_MS = 7L * 24 * 60 * 60 * 1000 // 7 days
    }
    
    override fun onReceive(context: Context, intent: Intent) {
        // Always refresh notification
        AdhanPersistentNotification.post(context)
        
        // Only reschedule alarms once per week (not every prayer refresh)
        val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val lastReschedule = prefs.getLong(LAST_RESCHEDULE_KEY, 0)
        val now = System.currentTimeMillis()
        
        if (now - lastReschedule > WEEK_MS) {
            AdhanPersistentNotification.scheduleRefreshAlarms(context)
            prefs.edit().putLong(LAST_RESCHEDULE_KEY, now).apply()
        }
    }
}