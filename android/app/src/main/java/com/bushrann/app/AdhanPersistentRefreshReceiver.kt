package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

// Fires 30 minutes before each prayer. Re-posts the persistent
// notification ONLY if the user dismissed it. If it's already
// showing, we do nothing.
class AdhanPersistentRefreshReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        AdhanPersistentNotification.repostIfDismissed(context)
    }
}
