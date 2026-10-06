package com.bushrann.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Build
import android.os.IBinder
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.widget.RemoteViews
import androidx.core.app.NotificationCompat

class AdhanForegroundService : Service() {
    private var mediaPlayer: MediaPlayer? = null
    private var vibrator: Vibrator? = null
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())
    private var currentPrayer: String = ""
    private var currentHours: Int = 0
    private var currentMinutes: Int = 0
    private var vibrationOnlyTimeout: Runnable? = null

    companion object {
        const val CHANNEL_ID = "adhan-foreground-service"
        const val NOTIFICATION_ID = 1001
        const val ACTION_STOP = "com.bushrann.app.STOP_ADHAN"
        private val LAST_ADHAN_CHANNEL_ID = "adhan-history"
        private val LAST_ADHAN_NOTIFICATION_ID = 1004

        // Upper bound for vibration-only adhan (active call in progress).
        private const val VIBRATION_ONLY_TIMEOUT_MILLIS = 60_000L
    }

    override fun onCreate() {
        super.onCreate()
        AdhanDiagnostics.init(this)
        createNotificationChannel()
        
        vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val vibratorManager = getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vibratorManager.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            AdhanDiagnostics.log("PLAYBACK_STOPPED", mapOf(
                "prayer" to currentPrayer,
                "reason" to "USER_STOP"
            ))
            postLastAdhanNote()
            stopAdhan()
            stopSelf()
            return START_NOT_STICKY
        }

        val prayer = intent?.getStringExtra("prayer") ?: "Prayer"
        val hours = intent?.getIntExtra("hours", 0) ?: 0
        val minutes = intent?.getIntExtra("minutes", 0) ?: 0
        currentPrayer = prayer
        currentHours = hours
        currentMinutes = minutes

        val styleIndex = intent?.getIntExtra("styleIndex", 0) ?: 0
        // A previous session's pending vibration-only timeout must never
        // stop/cancel the new session being started here.
        cancelVibrationOnlyTimeout()
        startForeground(NOTIFICATION_ID, buildNotification(prayer))
        AdhanDiagnostics.log("SERVICE_STARTED", mapOf(
            "prayer" to prayer,
            "callActive" to isCallActive()
        ))
        startVibration()
        if (isCallActive()) {
            // Active phone/VoIP call: vibrate only, never mix adhan audio
            // into the call. Bounded vibration, then end the adhan session.
            scheduleVibrationOnlyTimeout()
        } else {
            playAdhan(prayer, styleIndex)
        }

        return START_NOT_STICKY
    }

    // Schedules the bounded vibration-only timeout, replacing (cancelling)
    // any previously scheduled one.
    private fun scheduleVibrationOnlyTimeout() {
        cancelVibrationOnlyTimeout()
        val timeout = Runnable {
            vibrationOnlyTimeout = null
            vibrator?.cancel()
            stopSelf()
        }
        vibrationOnlyTimeout = timeout
        handler.postDelayed(timeout, VIBRATION_ONLY_TIMEOUT_MILLIS)
    }

    private fun cancelVibrationOnlyTimeout() {
        vibrationOnlyTimeout?.let { handler.removeCallbacks(it) }
        vibrationOnlyTimeout = null
    }

    // Privacy-safe call detection: AudioManager mode reflects an active
    // cellular call (MODE_IN_CALL) or VoIP/video communication session
    // (MODE_IN_COMMUNICATION). No phone-state permissions required.
    private fun isCallActive(): Boolean {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        return am.mode == AudioManager.MODE_IN_CALL ||
            am.mode == AudioManager.MODE_IN_COMMUNICATION
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

        // Collapsed-view Stop button: prayer info + labeled Stop button in the
        // standard 48dp collapsed content area. The expanded notification stays
        // the standard template with its existing "Stop" action.
        val collapsedView = RemoteViews(packageName, R.layout.adhan_collapsed).apply {
            setTextViewText(R.id.adhan_info, "🕌 $prayer Prayer Time")
            setOnClickPendingIntent(R.id.btn_stop_adhan, stopPendingIntent)
        }

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("🕌 $prayer Prayer Time")
            .setContentText("Adhan is playing... Tap Stop to end.")
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_media_pause, "Stop", stopPendingIntent)
            .setStyle(NotificationCompat.DecoratedCustomViewStyle())
            .setCustomContentView(collapsedView)
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
        // At most one live MediaPlayer owned by this service: detach and
        // release any previous player (and its pending callbacks) BEFORE
        // creating a new one, so a second onStartCommand can never orphan a
        // still-playing player that Stop could never reach.
        releaseCurrentPlayer()

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

            mediaPlayer = MediaPlayer().apply {
                val afd = resources.openRawResourceFd(resId)
                setDataSource(afd.fileDescriptor, afd.startOffset, afd.length)
                afd.close()
                setOnPreparedListener {
                    // Stale player (already replaced/released) must never start
                    if (mediaPlayer !== this) return@setOnPreparedListener
                    start()
                    AdhanDiagnostics.log("PLAYBACK_STARTED", mapOf(
                        "prayer" to prayer,
                        "appInForeground" to appOpen
                    ))
                    // Vibration: 25% of adhan when app open, 50% when app closed/killed
                    val duration = duration.toLong()
                    val vibrationMillis = if (appOpen) (duration / 4) else (duration / 2)
                    handler.postDelayed({ vibrator?.cancel() }, vibrationMillis)
                }
                setOnCompletionListener {
                    // Stale player must never stop/release the current one
                    if (mediaPlayer !== this) return@setOnCompletionListener
                    AdhanDiagnostics.log("PLAYBACK_COMPLETED", mapOf("prayer" to prayer))
                    postLastAdhanNote()
                    stopAdhan()
                    stopSelf()
                }
                setOnErrorListener { _, _, _ ->
                    if (mediaPlayer !== this) return@setOnErrorListener true
                    AdhanDiagnostics.log("PLAYBACK_ERROR", mapOf("prayer" to prayer))
                    stopSelf()
                    true
                }
                prepareAsync()
            }
        } catch (e: Exception) {
            e.printStackTrace()
            stopSelf()
        }
    }

    // Detaches callbacks and safely stops/releases the held player, if any.
    // Safe in every state (preparing, playing, completed, stopped, released)
    // and never touches the vibrator or the service lifecycle — playAdhan()
    // runs right after startVibration() for the new adhan.
    private fun releaseCurrentPlayer() {
        handler.removeCallbacksAndMessages(null)
        val old = mediaPlayer
        mediaPlayer = null
        old?.setOnPreparedListener(null)
        old?.setOnCompletionListener(null)
        old?.setOnErrorListener(null)
        try {
            if (old?.isPlaying == true) {
                old.stop()
            }
        } catch (e: Exception) {
        }
        try {
            old?.release()
        } catch (e: Exception) {
        }
    }

    private fun postLastAdhanNote() {
        if (currentPrayer.isEmpty()) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                LAST_ADHAN_CHANNEL_ID,
                "Last Adhan",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows the most recent adhan that played"
                setShowBadge(false)
            }
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(channel)
        }

        val openIntent = packageManager.getLaunchIntentForPackage(packageName)
        val openPending = PendingIntent.getActivity(
            this, 0, openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, LAST_ADHAN_CHANNEL_ID)
            .setContentTitle("🕌 It's $currentPrayer time")
            .setContentText("It's time to pray now")
            .setSmallIcon(R.mipmap.ic_launcher)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openPending)
            .build()

        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        nm.notify(LAST_ADHAN_NOTIFICATION_ID, notification)
    }

    private fun stopAdhan() {
        cancelVibrationOnlyTimeout()
        releaseCurrentPlayer()
        vibrator?.cancel()
    }

    override fun onDestroy() {
        super.onDestroy()
        stopAdhan()
    }
}
