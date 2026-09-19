package com.bushrann.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.PowerManager
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule

class ScreenStateModule(
    reactContext: ReactApplicationContext
) : ReactContextBaseJavaModule(reactContext) {

    private var quranPlaybackMode: String? = null

    @Volatile
    private var screenOn: Boolean = true

    private val screenReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (
                intent.action != Intent.ACTION_SCREEN_OFF &&
                intent.action != Intent.ACTION_SCREEN_ON
            ) {
                return
            }

            screenOn = intent.action == Intent.ACTION_SCREEN_ON

            android.util.Log.d(
                "ScreenState",
                "screenOn=$screenOn, mode=$quranPlaybackMode"
            )

            try {
                reactApplicationContext
                    .getJSModule(
                        DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
                    )
                    .emit("BushrannScreenStateChanged", screenOn)
            } catch (_: Exception) {
                // JS bridge may not be available during lifecycle transitions.
            }
        }
    }

    init {
        instance = this

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_SCREEN_ON)
        }

        reactApplicationContext.registerReceiver(
            screenReceiver,
            filter
        )

        val powerManager =
            reactApplicationContext.getSystemService(
                Context.POWER_SERVICE
            ) as? PowerManager

        screenOn = powerManager?.isInteractive ?: true
    }

    override fun getName(): String = "ScreenState"

    @ReactMethod
    fun setQuranPlaybackMode(mode: String?) {
        quranPlaybackMode = mode
    }

    @ReactMethod
    fun isScreenOn(promise: Promise) {
        promise.resolve(screenOn)
    }

    fun notifyUserLeave() {
        android.util.Log.d(
            "QuranLock",
            "notifyUserLeave called, mode=$quranPlaybackMode"
        )

        if (quranPlaybackMode != "lock") return

        try {
            reactApplicationContext
                .getJSModule(
                    DeviceEventManagerModule.RCTDeviceEventEmitter::class.java
                )
                .emit("BushrannUserLeave", null)

            android.util.Log.d(
                "QuranLock",
                "BushrannUserLeave emitted"
            )
        } catch (e: Exception) {
            android.util.Log.e(
                "QuranLock",
                "Failed to emit BushrannUserLeave",
                e
            )
        }
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

    override fun invalidate() {
        try {
            reactApplicationContext.unregisterReceiver(screenReceiver)
        } catch (_: Exception) {
        }

        quranPlaybackMode = null

        if (instance === this) {
            instance = null
        }

        super.invalidate()
    }

    companion object {
        @Volatile
        private var instance: ScreenStateModule? = null

        fun notifyUserLeaveFromActivity() {
            instance?.notifyUserLeave()
        }
    }
}