package com.bushrann.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

object AdhanNotificationHelper {

    private const val CHANNEL_ID = "adhan-alarm-channel"
    private const val NOTIFICATION_ID = 1003

    fun postAdhanNotification(
        context: Context,
        prayer: String,
        hours: Int,
        minutes: Int,
        styleIndex: Int
    ) {
        createChannel(context)

        // Full-screen intent — wakes device and shows notification even on lock screen
        val fullScreenIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        val fullScreenPending = PendingIntent.getActivity(
            context, 0, fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        // Dismiss action
        val dismissIntent = Intent(context, AdhanAlarmDismissReceiver::class.java).apply {
            action = "com.bushrann.app.DISMISS_ADHAN"
            putExtra("prayer", prayer)
        }
        val dismissPending = PendingIntent.getBroadcast(
            context, prayer.hashCode(), dismissIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setContentTitle("🕌 $prayer Prayer Time")
            .setContentText("It's time to pray. Adhan is playing...")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setAutoCancel(true)
            .setOngoing(false)
            .setFullScreenIntent(fullScreenPending, true)
            .setContentIntent(fullScreenPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Dismiss", dismissPending)
            .build()

        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(NOTIFICATION_ID, notification)

        // Play adhan sound + vibration
        playAdhan(context, prayer, styleIndex)
    }

    private fun createChannel(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Adhan Alarm",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Plays adhan call to prayer"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000)
                setSound(null, null) // We handle sound manually via MediaPlayer
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            }
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }
    }

    private fun playAdhan(context: Context, prayer: String, styleIndex: Int) {
        val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vm = context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }

        // Start vibration
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val effect = VibrationEffect.createWaveform(
                longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000), 0
            )
            vibrator.vibrate(effect)
        } else {
            @Suppress("DEPRECATION")
            vibrator.vibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000), 0)
        }

        // Play adhan sound
        try {
            val resId = when (prayer) {
                "Fajr" -> R.raw.adhan_fajr_short
                else -> when (styleIndex) {
                    1 -> R.raw.adhan_madinah_short
                    2 -> R.raw.adhan_aqsa_short
                    else -> R.raw.adhan_makkah_short
                }
            }

            MediaPlayer.create(context, resId).apply {
                setOnCompletionListener {
                    vibrator.cancel()
                    release()
                    cancelNotification(context)
                    AdhanPersistentNotification.post(context)
                }
                setOnErrorListener { _, _, _ ->
                    vibrator.cancel()
                    release()
                    cancelNotification(context)
                    AdhanPersistentNotification.post(context)
                    true
                }
                start()
            }
        } catch (e: Exception) {
            e.printStackTrace()
            vibrator.cancel()
        }
    }

    fun cancelNotification(context: Context) {
        val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.cancel(NOTIFICATION_ID)
    }
}