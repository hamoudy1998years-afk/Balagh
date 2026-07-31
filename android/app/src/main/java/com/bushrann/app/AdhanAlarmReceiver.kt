package com.bushrann.app

import android.app.ForegroundServiceStartNotAllowedException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build

class AdhanAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
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
    }
}