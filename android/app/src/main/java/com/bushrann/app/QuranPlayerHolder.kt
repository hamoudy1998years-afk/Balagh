package com.bushrann.app

import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession

/**
 * QuranPlayerHolder — single-owner registry for the native Quran player.
 *
 * STAGE 2.
 *
 * There can only ever be ONE native Quran ExoPlayer in the process. The
 * [QuranPlaybackService] is the only component allowed to create the
 * ExoPlayer and the MediaSession; it attaches them here. The
 * [QuranPlayerModule] (and any future native callers) must go through this
 * holder and must never construct an ExoPlayer itself.
 *
 * All fields are set/cleared on the main thread by the service.
 */
object QuranPlayerHolder {

    /** Media notification id for the Quran session. Distinct from Adhan's 1001. */
    const val NOTIFICATION_ID = 1002

    /** SharedPreferences file for native playback-state persistence. */
    const val PREFS_NAME = "quran_native_player"

    /** Player instance owned by QuranPlaybackService, or null if not running. */
    @Volatile
    var player: ExoPlayer? = null
        private set

    /** MediaSession owned by QuranPlaybackService, or null if not running. */
    @Volatile
    var session: MediaSession? = null
        private set

    /** Queue controller attached alongside the player. */
    @Volatile
    var controller: QuranQueueController? = null
        private set

    fun attach(
        p: ExoPlayer,
        s: MediaSession,
        c: QuranQueueController
    ) {
        player = p
        session = s
        controller = c
    }

    fun detach(p: ExoPlayer, s: MediaSession, c: QuranQueueController) {
        if (player === p) player = null
        if (session === s) session = null
        if (controller === c) controller = null
    }
}
