package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AdhanAlarmDismissReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == "com.bushrann.app.DISMISS_ADHAN") {
            AdhanNotificationHelper.cancelNotification(context)
        }
    }
}