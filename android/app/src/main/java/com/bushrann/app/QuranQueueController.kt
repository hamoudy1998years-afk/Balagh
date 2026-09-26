package com.bushrann.app

import android.content.Context
import android.content.SharedPreferences
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.WritableMap

/**
 * QuranQueueController — owns the Media3 queue for native Quran playback.
 *
 * STAGE 2.
 *
 * Responsibilities:
 *  - Build and extend a rolling window of MediaItems starting from the
 *    requested surah/verse, advancing through Surah 114 entirely natively
 *    (no JS involvement needed for queue advancement or extension).
 *  - Bismillah rules: an extra Bismillah item precedes verse 1 of every
 *    surah except Surah 1 (Al-Fatihah) and Surah 9 (At-Tawbah).
 *  - MediaItem identity preserves surah/verse/Bismillah info both in the
 *    mediaId ("bismillah", "s:<surah>:<verse>") and in the extras bundle
 *    (surah, verse, verseKey, isBismillah). MediaSession metadata updates
 *    automatically as tracks advance because metadata lives on each
 *    MediaItem.
 *  - Error policy: NEVER silently skip a verse. On an unrecoverable
 *    playback/network error: pause at the exact item, preserve position,
 *    persist state, expose a sticky error, and wait for the caller to
 *    retry (resume()) or reload. Playback never auto-advances past a
 *    failed verse.
 *  - Natural completion of Surah 114 verse 6 ends the queue cleanly and
 *    emits an "ended" signal (not an error).
 *  - Persists playback position/state to SharedPreferences so JS can read
 *    it after suspension or process death.
 *  - Emits foreground UI-sync events (track change, state, error, ended).
 *
 * All methods must be called on the main thread.
 */
class QuranQueueController(
    private val context: Context,
    private val player: ExoPlayer,
    private val eventEmitter: (String, WritableMap) -> Unit
) : Player.Listener {

    companion object {
        private const val TAG = "QuranPlayer"

        // Verified 114-surah verse-count table.
        val VERSE_COUNTS: IntArray = intArrayOf(
            7, 286, 200, 176, 120, 165, 206, 75, 129, 109,
            123, 111, 43, 52, 99, 128, 111, 110, 98, 135,
            112, 78, 118, 64, 77, 227, 93, 88, 69, 60,
            34, 30, 73, 54, 45, 83, 182, 88, 75, 85,
            54, 53, 89, 59, 37, 35, 38, 29, 18, 45,
            60, 49, 62, 55, 78, 96, 29, 22, 24, 13,
            14, 11, 11, 18, 12, 12, 30, 52, 52, 44,
            28, 28, 20, 56, 40, 31, 50, 40, 46, 42,
            29, 19, 36, 25, 22, 17, 19, 26, 30, 20,
            15, 21, 11, 8, 8, 19, 5, 8, 8, 11,
            11, 8, 3, 9, 5, 4, 7, 3, 6, 3,
            5, 4, 5, 6
        )

        const val SURAHS = 114
        const val RECITER_NAME = "Mishary Rashid Alafasy"
        const val URL_BASE = "https://verses.quran.com/Alafasy/mp3/"

        // Rolling-window tuning.
        private const val EXTEND_THRESHOLD = 2 // extend when within N items of window end
        private const val KEEP_BEHIND = 5      // trim items more than N behind current

        // Event names sent to JS (foreground UI sync only; queue logic never
        // depends on JS receiving them).
        const val EVENT_TRACK_CHANGED = "QuranPlayer:onTrackChanged"
        const val EVENT_STATE = "QuranPlayer:onPlaybackState"
        const val EVENT_ERROR = "QuranPlayer:onError"
        const val EVENT_ENDED = "QuranPlayer:onEnded"

        // Persisted-state keys.
        private const val KEY_MEDIA_ID = "mediaId"
        private const val KEY_SURA = "surah"
        private const val KEY_VERSE = "verse"
        private const val KEY_VERSE_KEY = "verseKey"
        private const val KEY_IS_BISMILLAH = "isBismillah"
        private const val KEY_POSITION_MS = "positionMs"
        private const val KEY_DURATION_MS = "durationMs"
        private const val KEY_IS_PLAYING = "isPlaying"
        private const val KEY_ENDED = "ended"
        private const val KEY_ERROR = "error"
        private const val KEY_RECITER = "reciter"
        private const val KEY_UPDATED_AT = "updatedAtMs"

        private const val POSITION_SAVE_INTERVAL_MS = 10_000L
    }

    /** Surah number (1..114) of the last surah currently in the window. */
    private var lastSurahInWindow = 0

    /** Reciter identifier echoed from the last loadQueue call. */
    private var reciter = RECITER_NAME

    /** Sticky error: set on failure, cleared on successful retry/load/stop. */
    @Volatile
    private var stickyError: String? = null

    /** True once the queue has naturally completed at Surah 114 verse 6. */
    @Volatile
    private var ended = false

    private val prefs: SharedPreferences =
        context.getSharedPreferences(QuranPlayerHolder.PREFS_NAME, Context.MODE_PRIVATE)

    private val handler = Handler(Looper.getMainLooper())

    /** Periodically persists position while playing (process-death safety). */
    private val positionSaver = object : Runnable {
        override fun run() {
            if (player.isPlaying && stickyError == null && !ended) {
                persistState()
            }
            handler.postDelayed(this, POSITION_SAVE_INTERVAL_MS)
        }
    }

    init {
        player.addListener(this)
        handler.postDelayed(positionSaver, POSITION_SAVE_INTERVAL_MS)
    }

    // ───────────────────────── queue construction ─────────────────────────

    private fun verseUrl(surah: Int, verse: Int): String {
        val padded = surah.toString().padStart(3, '0') +
            verse.toString().padStart(3, '0')
        return URL_BASE + padded + ".mp3"
    }

    private fun buildMediaItem(
        surah: Int,
        verse: Int,
        isBismillah: Boolean
    ): MediaItem {
        val verseKey = "$surah:$verse"
        val mediaId = if (isBismillah) {
            "bismillah:$surah"
        } else {
            "s:$surah:$verse"
        }
        val title = if (isBismillah) {
            "Bismillah — $verseKey"
        } else {
            "Surah $surah — $verseKey"
        }
        val extras = android.os.Bundle().apply {
            putInt("surah", surah)
            putInt("verse", verse)
            putString("verseKey", verseKey)
            putBoolean("isBismillah", isBismillah)
        }
        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(RECITER_NAME)
            .setExtras(extras)
            .build()
        // The Bismillah item reuses the shared 1:1 recitation audio
        // (001001.mp3), exactly like the existing QuranScreen implementation,
        // while its identity/extras still describe the TARGET surah.
        val uri = if (isBismillah) verseUrl(1, 1) else verseUrl(surah, verse)
        return MediaItem.Builder()
            .setMediaId(mediaId)
            .setUri(uri)
            .setMediaMetadata(metadata)
            .build()
    }

    /**
     * Items for one surah: optional Bismillah prefix (all surahs except 1 and
     * 9), followed by every verse.
     */
    private fun buildSurahItems(surah: Int): List<MediaItem> {
        val items = mutableListOf<MediaItem>()
        if (surah != 1 && surah != 9) {
            items += buildMediaItem(surah, 0, true)
        }
        for (v in 1..VERSE_COUNTS[surah - 1]) {
            items += buildMediaItem(surah, v, false)
        }
        return items
    }

    /**
     * Loads a queue beginning at items[startIndex] (a surah:verse list) and
     * starts playback at [startPositionMs] into that verse.
     *
     * [items] entries may be strings ("<surah>:<verse>") or maps with
     * numeric "surah"/"verse" keys. Native code does not depend on the full
     * list after load — the window is extended natively from the verse table.
     */
    fun loadQueue(
        items: ReadableArray,
        startIndex: Int,
        startPositionMs: Double,
        reciterName: String
    ) {
        if (items.size() == 0 || startIndex < 0 || startIndex >= items.size()) {
            eventEmitter(EVENT_ERROR, errorMap("Invalid loadQueue arguments"))
            return
        }

        var startSurah: Int
        var startVerse: Int
        when {
            items.getType(startIndex) ==
                com.facebook.react.bridge.ReadableType.Map -> {
                val first = items.getMap(startIndex)!!
                startSurah = first.getInt("surah")
                startVerse = first.getInt("verse")
            }
            items.getType(startIndex) ==
                com.facebook.react.bridge.ReadableType.String -> {
                val parts = items.getString(startIndex)!!.split(":")
                if (parts.size != 2) {
                    eventEmitter(
                        EVENT_ERROR,
                        errorMap("loadQueue string items must be \"surah:verse\"")
                    )
                    return
                }
                startSurah = parts[0].toIntOrNull() ?: -1
                startVerse = parts[1].toIntOrNull() ?: -1
            }
            else -> {
                eventEmitter(EVENT_ERROR, errorMap("loadQueue items must be objects or strings"))
                return
            }
        }
        if (startSurah !in 1..SURAHS ||
            startVerse !in 1..VERSE_COUNTS[startSurah - 1]
        ) {
            eventEmitter(EVENT_ERROR, errorMap("loadQueue start out of range"))
            return
        }

        reciter = reciterName.ifBlank { RECITER_NAME }
        stickyError = null
        ended = false
        lastSurahInWindow = startSurah

        player.stop()
        player.clearMediaItems()
        player.setMediaItems(buildSurahItems(startSurah))

        // In-window index of the start verse: +1 when a Bismillah prefix
        // occupies index 0.
        val bismillahPrefix = if (startSurah != 1 && startSurah != 9) 1 else 0
        val windowIndex = startVerse - 1 + bismillahPrefix
        player.seekTo(windowIndex, startPositionMs.toLong().coerceAtLeast(0L))
        player.prepare()
        player.play()

        persistState()
        emitState()
    }

    // ───────────────────────── Player.Listener ─────────────────────────

    override fun onMediaItemTransition(
        mediaItem: MediaItem?,
        reason: @Player.MediaItemTransitionReason Int
    ) {
        if (mediaItem == null) return
        trimWindowBehindCurrent()
        maybeExtendWindow()
        persistState()
        val map = Arguments.createMap()
        putIdentity(map, mediaItem)
        eventEmitter(EVENT_TRACK_CHANGED, map)
        emitState()
    }

    override fun onPlaybackStateChanged(state: @Player.State Int) {
        Log.d(
            TAG,
            "onPlaybackStateChanged state=$state " +
                "mediaId=${player.currentMediaItem?.mediaId} " +
                "positionMs=${player.currentPosition} " +
                "playWhenReady=${player.playWhenReady} " +
                "isPlaying=${player.isPlaying} " +
                "ended=$ended"
        )
        if (state == Player.STATE_ENDED) {
            val item = player.currentMediaItem
            val extras = item?.mediaMetadata?.extras
            val isFinal = extras != null &&
                extras.getInt("surah", -1) == SURAHS &&
                extras.getInt("verse", -1) == VERSE_COUNTS[SURAHS - 1] &&
                !extras.getBoolean("isBismillah", false)
            if (isFinal && stickyError == null && !ended) {
                Log.d(TAG, "final natural completion at 114:6")
                ended = true
                // Order matters: persist the final state (114:6, final
                // position, ended=true, isPlaying=false) FIRST, then notify
                // JS, then terminate the service. onDestroy re-persists via
                // release(), but the player still holds the same final item
                // and position at that point, so the stored values are
                // rewritten identically — never clobbered.
                persistState()
                eventEmitter(EVENT_ENDED, Arguments.createMap())
                (context as? android.app.Service)?.stopSelf()
            }
        }
        emitState()
    }

    override fun onIsPlayingChanged(isPlaying: Boolean) {
        Log.d(
            TAG,
            "onIsPlayingChanged isPlaying=$isPlaying " +
                "mediaId=${player.currentMediaItem?.mediaId} " +
                "positionMs=${player.currentPosition} " +
                "playWhenReady=${player.playWhenReady} " +
                "stickyError=$stickyError"
        )
        if (isPlaying && stickyError != null) {
            // A successful (re)start clears the sticky error.
            stickyError = null
        }
        if (!isPlaying) {
            persistState()
        }
        emitState()
    }

    override fun onPlayerError(error: PlaybackException) {
        Log.e(
            TAG,
            "onPlayerError code=${error.errorCodeName} " +
                "message=${error.message} " +
                "mediaId=${player.currentMediaItem?.mediaId} " +
                "positionMs=${player.currentPosition}"
        )
        // NEVER skip to the next verse on failure. Pause at the exact item,
        // preserve position, persist, surface the error, and wait for the
        // caller to resume()/retry or reload.
        player.pause()
        stickyError = error.errorCodeName + ": " + (error.message ?: "playback error")
        persistState()
        eventEmitter(EVENT_ERROR, errorMap(stickyError ?: "unknown error"))
        emitState()
    }

    // ───────────────────────── rolling window ─────────────────────────

    private fun maybeExtendWindow() {
        while (lastSurahInWindow < SURAHS &&
            player.mediaItemCount > 0 &&
            player.currentMediaItemIndex >= player.mediaItemCount - EXTEND_THRESHOLD
        ) {
            lastSurahInWindow += 1
            player.addMediaItems(buildSurahItems(lastSurahInWindow))
        }
    }

    private fun trimWindowBehindCurrent() {
        val current = player.currentMediaItemIndex
        val trimBefore = current - KEEP_BEHIND
        if (trimBefore > 0) {
            player.removeMediaItems(0, trimBefore)
        }
    }

    // ───────────────────────── transport API ─────────────────────────

    /** Play/pause toggle helpers used by the module. */

    fun play() {
        if (ended) return
        if (stickyError != null) {
            // Retrying after an error must retry the SAME verse.
            player.prepare()
        }
        player.play()
    }

    fun pause() {
        // Mid-verse pause keeps the same media item and position.
        player.pause()
        persistState()
        emitState()
    }

    fun resume() {
        if (ended) return
        if (stickyError != null) {
            player.prepare()
        }
        player.play()
    }

    fun stop() {
        Log.d(
            TAG,
            "stop mediaId=${player.currentMediaItem?.mediaId} " +
                "positionMs=${player.currentPosition}"
        )
        // Pause, reset to the start of the current item, clear error,
        // persist. Teardown/notification removal happens in release().
        stickyError = null
        player.pause()
        if (player.mediaItemCount > 0) {
            player.seekTo(player.currentMediaItemIndex, 0L)
        }
        persistState()
        emitState()
    }

    fun seekTo(positionMs: Double) {
        if (player.mediaItemCount > 0) {
            player.seekTo(positionMs.toLong().coerceAtLeast(0L))
            persistState()
        }
        emitState()
    }

    fun release() {
        Log.d(TAG, "release")
        handler.removeCallbacks(positionSaver)
        persistState()
        // The service owns actual release of player/session.
    }

    // ───────────────────────── state / persistence ─────────────────────────

    private fun putIdentity(map: WritableMap, item: MediaItem) {
        val extras = item.mediaMetadata.extras
        if (extras != null) {
            map.putInt("surah", extras.getInt("surah", -1))
            map.putInt("verse", extras.getInt("verse", -1))
            map.putString("verseKey", extras.getString("verseKey"))
            map.putBoolean("isBismillah", extras.getBoolean("isBismillah", false))
        }
        map.putString("mediaId", item.mediaId)
    }

    fun getPlaybackState(): WritableMap {
        val map = Arguments.createMap()
        val item = player.currentMediaItem
        if (item != null) {
            putIdentity(map, item)
            map.putDouble("positionMs", player.currentPosition.toDouble())
            map.putDouble("durationMs", player.duration.coerceAtLeast(0L).toDouble())
        }
        map.putBoolean("isPlaying", player.isPlaying)
        map.putInt("trackCount", player.mediaItemCount)
        map.putBoolean("ended", ended)
        map.putString("reciter", reciter)
        stickyError?.let { map.putString("error", it) }
        return map
    }

    private fun persistState() {
        val item = player.currentMediaItem ?: return
        val extras = item.mediaMetadata.extras
        val ed = prefs.edit()
        ed.putString(KEY_MEDIA_ID, item.mediaId)
        if (extras != null) {
            ed.putInt(KEY_SURA, extras.getInt("surah", -1))
            ed.putInt(KEY_VERSE, extras.getInt("verse", -1))
            ed.putString(KEY_VERSE_KEY, extras.getString("verseKey"))
            ed.putBoolean(KEY_IS_BISMILLAH, extras.getBoolean("isBismillah", false))
        }
        ed.putLong(KEY_POSITION_MS, player.currentPosition.coerceAtLeast(0L))
        ed.putLong(KEY_DURATION_MS, player.duration.coerceAtLeast(0L))
        ed.putBoolean(KEY_IS_PLAYING, player.isPlaying)
        ed.putBoolean(KEY_ENDED, ended)
        if (stickyError != null) ed.putString(KEY_ERROR, stickyError) else ed.remove(KEY_ERROR)
        ed.putString(KEY_RECITER, reciter)
        ed.putLong(KEY_UPDATED_AT, SystemClock.elapsedRealtime())
        ed.apply()
    }

    private fun emitState() {
        eventEmitter(EVENT_STATE, getPlaybackState())
    }

    private fun errorMap(message: String): WritableMap {
        val map = Arguments.createMap()
        map.putString("message", message)
        val item = player.currentMediaItem
        if (item != null) putIdentity(map, item)
        map.putDouble("positionMs", player.currentPosition.toDouble())
        return map
    }
}
