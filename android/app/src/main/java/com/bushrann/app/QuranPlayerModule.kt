package com.bushrann.app

import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.module.annotations.ReactModule

/**
 * QuranPlayer — native Quran playback module.
 *
 * STAGE 2.
 *
 * Thin bridge over the single native ExoPlayer owned by
 * [QuranPlaybackService] and registered in [QuranPlayerHolder]. The module
 * never creates a player itself. All player calls are posted to the main
 * thread; before the first queue load the service is started so the holder
 * is populated.
 *
 * Queue construction, advancement, extension, Bismillah handling, metadata,
 * error policy, and completion are entirely native (QuranQueueController) —
 * no JS event is required for correct playback.
 *
 * Failure policy: on an unrecoverable verse/network error the native player
 * pauses at the exact verse, preserves position, persists state, exposes a
 * sticky error via getPlaybackState()/onError, and waits for resume()
 * (retry) or a fresh loadQueue(). A verse is NEVER silently skipped.
 *
 * Stage 2 does NOT integrate with QuranScreen.js; the existing expo-audio
 * implementation remains the active playback path in the app.
 */
@ReactModule(name = QuranPlayerModule.NAME)
class QuranPlayerModule(reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun getName(): String = NAME

    /**
     * Starts the service (if needed) and runs [block] on the main thread with
     * the queue controller. Resolves [promise] with [fallback] when the
     * native player is not available (service not started yet).
     */
    private fun withController(
        promise: Promise? = null,
        fallback: Any? = null,
        block: (QuranQueueController) -> Unit
    ) {
        // Make sure the holder is populated even if the service was not
        // running. If this is the first call the posted block runs after
        // onCreate, so the controller will be present.
        val context = reactApplicationContext
        try {
            context.startService(Intent(context, QuranPlaybackService::class.java))
        } catch (_: Throwable) {
            // Background-start restrictions: fall through; the block will
            // report unavailability via the fallback.
        }

        mainHandler.post {
            val controller = QuranPlayerHolder.controller
            if (controller == null) {
                // One retry after the service has had a chance to start.
                mainHandler.postDelayed({
                    val retry = QuranPlayerHolder.controller
                    if (retry != null) {
                        block(retry)
                    } else {
                        promise?.resolve(fallback)
                    }
                }, 100)
            } else {
                block(controller)
            }
        }
    }

    /**
     * items: array of maps ({surah, verse}) or "surah:verse" strings.
     * startIndex indexes into [items]; startPositionMs seeks into that verse.
     */
    @ReactMethod
    fun loadQueue(
        items: ReadableArray,
        startIndex: Int,
        startPositionMs: Double,
        reciter: String,
        promise: Promise
    ) {
        withController(promise, fallback = null) { controller ->
            controller.loadQueue(items, startIndex, startPositionMs, reciter)
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun play(promise: Promise) {
        withController(promise, fallback = null) { controller ->
            controller.play()
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun pause(promise: Promise) {
        withController(promise, fallback = null) { controller ->
            controller.pause()
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun resume(promise: Promise) {
        withController(promise, fallback = null) { controller ->
            controller.resume()
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        withController(promise, fallback = null) { controller ->
            controller.stop()
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun seekTo(positionMs: Double, promise: Promise) {
        withController(promise, fallback = null) { controller ->
            controller.seekTo(positionMs)
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun getPlaybackState(promise: Promise) {
        withController(promise, fallback = Arguments.createMap()) { controller ->
            promise.resolve(controller.getPlaybackState())
        }
    }

    @ReactMethod
    fun release(promise: Promise) {
        withController(promise, fallback = null) { controller ->
            // Persist final state. Actual player/session teardown and
            // notification removal happen in QuranPlaybackService.onDestroy.
            controller.release()
            mainHandler.post {
                try {
                    reactApplicationContext.stopService(
                        Intent(reactApplicationContext, QuranPlaybackService::class.java)
                    )
                } catch (_: Throwable) {
                }
                promise.resolve(null)
            }
        }
    }

    companion object {
        const val NAME = "QuranPlayer"
    }

    // Required by React Native NativeEventEmitter.
    @ReactMethod
    fun addListener(eventName: String) {
        // No per-listener native bookkeeping required.
    }

    @ReactMethod
    fun removeListeners(count: Int) {
        // No per-listener native bookkeeping required.
    }
}
