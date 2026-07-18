package com.bushrann.app

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
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }

        // Prayer time reached — refresh the persistent notification content
        AdhanPersistentNotification.post(context)
    }
}
