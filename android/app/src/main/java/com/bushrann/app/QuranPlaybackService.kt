package com.bushrann.app

import android.app.PendingIntent
import android.content.Intent
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import com.facebook.react.bridge.WritableMap
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * QuranPlaybackService — MediaSessionService hosting the single native
 * Quran ExoPlayer.
 *
 * STAGE 2.
 *
 *  - Owns the only Quran ExoPlayer in the process (per QuranPlayerHolder).
 *  - Holds the MediaSession; the Media3 media notification is derived
 *    automatically from the session with notification id
 *    QuranPlayerHolder.NOTIFICATION_ID (1002), kept distinct from Adhan's
 *    1001. Nothing here touches Adhan code or notifications.
 *  - MediaItem metadata (title/artist set on each MediaItem by
 *    QuranQueueController) updates the session/notification automatically
 *    as tracks advance.
 *  - Next/Previous are unavailable: the session callback strips the
 *    seek-to-next/previous commands from the available command set.
 *  - Audio focus is handled by ExoPlayer (setAudioAttributes with
 *    handleAudioFocus = true) and audio-becoming-noisy pauses playback.
 *
 * Stage 2 does NOT start this service from anywhere in the app; it is
 * started only via the QuranPlayer module (or a future Stage-3 caller).
 * Existing expo-audio Quran playback in QuranScreen.js is unaffected.
 */
class QuranPlaybackService : MediaSessionService() {

    private var player: ExoPlayer? = null
    private var session: MediaSession? = null
    private var controller: QuranQueueController? = null

    override fun onCreate() {
        super.onCreate()
        android.util.Log.d("QuranService", "onCreate")

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        val exoPlayer = ExoPlayer.Builder(this).build().apply {
            setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            setHandleAudioBecomingNoisy(true)
        }

        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        // Strip Next/Previous (and seek-to-adjacent) from the controller UI.
        val sessionCallback = object : MediaSession.Callback {
            override fun onConnect(
                session: MediaSession,
                controller: MediaSession.ControllerInfo
            ): MediaSession.ConnectionResult {
                val playerCommands = Player.Commands.Builder()
                    .addAllCommands()
                    .remove(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
                    .remove(Player.COMMAND_SEEK_TO_NEXT)
                    .remove(Player.COMMAND_SEEK_TO_PREVIOUS)
                    .build()
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailablePlayerCommands(playerCommands)
                    .build()
            }
        }

        val mediaSession = MediaSession.Builder(this, exoPlayer)
            .setId("quran_session")
            .setSessionActivity(pendingIntent)
            .setCallback(sessionCallback)
            .build()

        val emitter: (String, WritableMap) -> Unit = { event, map ->
            // Best-effort foreground UI sync; queue logic never depends on JS.
            try {
                (applicationContext as? com.facebook.react.ReactApplication)
                    ?.reactHost
                    ?.currentReactContext
                    ?.getJSModule(
                        DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
                    )
                    ?.emit(event, map)
            } catch (_: Throwable) {
            }
        }

        val queueController = QuranQueueController(this, exoPlayer, emitter)

        player = exoPlayer
        session = mediaSession
        controller = queueController
        QuranPlayerHolder.attach(exoPlayer, mediaSession, queueController)

        // Register the session with the service so Media3's
        // MediaNotificationManager attaches its player listener: this is
        // what moves the service to the foreground (mediaPlayback) with
        // the media notification while playback is ongoing, and demotes
        // it when playback stops. Without this, no controller ever binds
        // (the app talks to the player directly through the module), so
        // the session would never be added and the service would remain
        // a plain background service that the system kills when idle.
        addSession(mediaSession)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return session
    }

    override fun onDestroy() {
        android.util.Log.d("QuranService", "onDestroy")
        controller?.release()
        val p = player
        val s = session
        val c = controller
        player = null
        session = null
        controller = null
        if (p != null && s != null && c != null) {
            QuranPlayerHolder.detach(p, s, c)
        }
        s?.release()
        p?.release()
        super.onDestroy()
    }
}
