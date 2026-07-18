package com.bushrann.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import androidx.core.app.NotificationCompat

class AdhanForegroundService : Service() {
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    companion object {
        const val CHANNEL_ID = "adhan-foreground-service"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.bushrann.app.STOP_ADHAN"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        
        val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
        vibrator = vibratorManager.defaultVibrator
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopAdhan()
            stopSelf()
            return START_NOT_STICKY
        }

        val prayer = intent?.getStringExtra("prayer") ?: "Prayer"
        val hours = intent?.getIntExtra("hours", 0) ?: 0
        val minutes = intent?.getIntExtra("minutes", 0) ?: 0

        val styleIndex = intent?.getIntExtra("styleIndex", 0) ?: 0
        startForeground(NOTIFICATION_ID, buildNotification(prayer))
        startVibration()
        playAdhan(prayer, styleIndex)

        return START_NOT_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Adhan Service",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Plays full Adhan call to prayer"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000)
            }
            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(prayer: String): Notification {
        val stopIntent = Intent(this, AdhanForegroundService::class.java).apply {
            action = ACTION_STOP
        }
        val stopPendingIntent = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🕌 $prayer Prayer Time")
            .setContentText("Adhan is playing... Tap Stop to end.")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()
    }

    private fun startVibration() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val effect = VibrationEffect.createWaveform(
                longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000),
                0
            )
            vibrator?.vibrate(effect)
        } else {
            vibrator?.vibrate(longArrayOf(0, 1000, 500, 1000, 500, 1000, 500, 1000), 0)
        }
    }

    private fun playAdhan(prayer: String, styleIndex: Int = 0) {
        try {
            val appOpen = AdhanModule.isAppInForeground
            val resId = if (appOpen) {
                when (prayer) {
                    "Fajr" -> R.raw.adhan_fajr
                    else -> when (styleIndex) {
                        1 -> R.raw.adhan_madinah
                        2 -> R.raw.adhan_aqsa
                        else -> R.raw.adhan_makkah
                    }
                }
            } else {
                when (prayer) {
                    "Fajr" -> R.raw.adhan_fajr_short
                    else -> when (styleIndex) {
                        1 -> R.raw.adhan_madinah_short
                        2 -> R.raw.adhan_aqsa_short
                        else -> R.raw.adhan_makkah_short
                    }
                }
            }

            mediaPlayer = MediaPlayer.create(this, resId).apply {
                setOnCompletionListener {
                    stopAdhan()
                    stopSelf()
                }
                start()
                // Vibration: 25% of adhan when app open, 50% when app closed/killed
                val vibrationMillis = if (appOpen) (duration / 4).toLong() else (duration / 2).toLong()
                handler.postDelayed({ vibrator?.cancel() }, vibrationMillis)
            }
        } catch (e: Exception) {
            e.printStackTrace()
            stopSelf()
        }
    }

    private fun stopAdhan() {
        handler.removeCallbacksAndMessages(null)
        mediaPlayer?.apply {
            if (isPlaying) {
                stop()
            }
            release()
        }
        mediaPlayer = null
        vibrator?.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAdhan()
    }
}
