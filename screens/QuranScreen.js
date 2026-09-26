// ─────────────────────────────────────────────
//  QuranScreen.js — Surah List Browser
//  Performance: surah list cached in AsyncStorage
//  after first load — instant on all subsequent opens.
// ─────────────────────────────────────────────

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  StatusBar,
  AppState,
  Alert,
  NativeModules,
  NativeEventEmitter,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { Ionicons } from '@expo/vector-icons';
import { SystemBars } from 'react-native-edge-to-edge';
import { fetchSurahs, fetchVerses, fetchVerseAudioUrl } from '../services/quranApi';
import { createAudioPlayer, setAudioModeAsync } from 'expo-audio';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { COLORS } from '../constants/theme';
import { isLowEndDevice } from '../utils/deviceInfo';
import PlaybackModeDialog from '../components/PlaybackModeDialog';

const { ScreenState, QuranPlayer } = NativeModules;

// Native Quran player event names (Stage 2). Foreground UI sync only —
// queue progression is entirely native and never depends on these.
const NATIVE_EVENTS = {
  trackChanged: 'QuranPlayer:onTrackChanged',
  state: 'QuranPlayer:onPlaybackState',
  error: 'QuranPlayer:onError',
  ended: 'QuranPlayer:onEnded',
};

// Best-effort call on the native QuranPlayer bridge.
function nativeCall(method, ...args) {
  return new Promise((resolve) => {
    try {
      const result = QuranPlayer?.[method]?.(...args);
      if (result && typeof result.then === 'function') {
        result.then(resolve).catch(() => resolve(null));
      } else {
        resolve(result ?? null);
      }
    } catch (_) {
      resolve(null);
    }
  });
}

// Map an authoritative native playback state into the existing
// quran_resume_position format ({ surahIndex, verseIndex, surahName }).
// Native surah is 1-based and native verse is 1-based; a Bismillah item
// carries verse=0 with the TARGET surah identity — it maps to verseIndex 0
// (start of the surah), exactly like the existing JS Bismillah stop path.
function nativeStateToResume(st, surahsList) {
  if (!st || typeof st.surah !== 'number' || st.surah < 1) return null;
  const surahIndex = st.surah - 1;
  const surah = surahsList?.[surahIndex];
  const verseCount = surah?.verses_count ?? 1;
  const verseIndex =
    typeof st.verse === 'number' && st.verse >= 1
      ? Math.min(st.verse - 1, verseCount - 1)
      : 0;
  return {
    surahIndex,
    verseIndex,
    surahName: surah?.name_simple ?? `Surah ${st.surah}`,
  };
}

const REVELATION_COLORS = {
  Makkah: '#c9a84c',
  Madinah: '#4c9ac9',
};

const SURAHS_CACHE_KEY = 'quran_surahs_cache';
const SURAHS_CACHE_TTL = 7 * 24 * 60 * 60 * 1000; // 1 week — Quran doesn't change

const RECITER_NAME = 'Mishary Rashid Alafasy';

// Safely stop + remove an expo-audio player without throwing/unhandled rejections.
// pause() first so a pending playAudioUntilDone listener gets a final status event.
async function releasePlayer(player) {
  if (!player) return;
  try {
    player.pause();
  } catch (_) {}
  try {
    player.remove();
  } catch (_) {}
}

// Full stop of the run's shared player: drop lock-screen controls, release it,
// and clear the ref. expo-audio handles background playback natively.
function stopActivePlayer(soundRef) {
  const player = soundRef.current;
  soundRef.current = null;
  if (!player) return;
  try {
    player.setActiveForLockScreen(false);
  } catch (_) {}
  releasePlayer(player);
}

export default function QuranScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const [surahs, setSurahs] = useState([]);
  const [filtered, setFiltered] = useState([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isPlayingQuran, setIsPlayingQuran] = useState(false);
  const [resumePosition, setResumePosition] = useState(null);
  const [playbackDialogVisible, setPlaybackDialogVisible] = useState(false);
  const [pendingPlayParams, setPendingPlayParams] = useState({ si: 0, vi: 0 });
  const quranPlayingRef = useRef(false);
  const soundRef = useRef(null);
  // Set when a run is stopped on purpose (Stop button, unmount, or app-mode
  // background). Used to counter expo-audio's native auto-resume on foreground.
  const intentionallyStoppedRef = useRef(false);
  // Set while a native QuranPlayer run owns playback (background/lock modes).
  const nativeRunActiveRef = useRef(false);
  // Latest native playback state, mirrored for UI/resume sync only.
  const nativeStateRef = useRef(null);
  // Stop callback of the currently active run (JS or native).
  const activeStopRef = useRef(null);
  const surahsRef = useRef([]);
  const isMountedRef = useRef(true);
  // Generation token: every new playback run gets its own token.
  // Stopping or unmounting invalidates the token so stale runs exit.
  const playTokenRef = useRef(0);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Component unmounting — invalidate playback, stop audio, prevent leaks.
      playTokenRef.current += 1;
      quranPlayingRef.current = false;
      intentionallyStoppedRef.current = true;
      stopActivePlayer(soundRef);

      if (nativeRunActiveRef.current) {
        nativeRunActiveRef.current = false;
        try {
          QuranPlayer?.stop();
          QuranPlayer?.release();
        } catch (_) {}
      }

      try {
        ScreenState?.setQuranPlaybackMode(null);
      } catch (_) {}
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      const { DeviceEventEmitter } = require('react-native');
      DeviceEventEmitter.emit('pauseAllVideos');
      return () => SystemBars.popStackEntry(entry);
    }, [])
  );

  useEffect(() => {
    async function loadResumePosition() {
      try {
        const saved = await AsyncStorage.getItem('quran_resume_position');
        if (saved && isMountedRef.current) {
          setResumePosition(JSON.parse(saved));
        }
      } catch (_) {}
    }
    loadResumePosition();
  }, []);

  useEffect(() => {
    loadSurahs();
  }, []);

  async function loadSurahs() {
    try {
      setError(null);

      // Fast path: load from cache first
      const raw = await AsyncStorage.getItem(SURAHS_CACHE_KEY);
      if (raw) {
        const { data, timestamp } = JSON.parse(raw);
        const isExpired = Date.now() - timestamp > SURAHS_CACHE_TTL;
        if (!isExpired && data?.length > 0) {
          if (isMountedRef.current) {
            setSurahs(data);
            surahsRef.current = data;
            setFiltered(data);
            setLoading(false);
          }
          // Don't refresh in background — Quran list never changes
          return;
        }
      }

      // Slow path: no cache — fetch from API
      if (isMountedRef.current) setLoading(true);
      const data = await fetchSurahs();
      if (isMountedRef.current) {
        setSurahs(data);
        surahsRef.current = data;
        setFiltered(data);
      }

      await AsyncStorage.setItem(SURAHS_CACHE_KEY, JSON.stringify({
        data,
        timestamp: Date.now(),
      }));

    } catch (e) {
      if (isMountedRef.current) {
        setError('Could not load surahs. Check your connection.');
      }
    } finally {
      if (isMountedRef.current) setLoading(false);
    }
  }

  async function playAudioUntilDone(player) {
    return new Promise((resolve) => {
      let settled = false;
      let sub = null;
      const done = (reason) => {
        if (settled) return;
        settled = true;
        if (sub) {
          try {
            sub.remove();
          } catch (_) {}
        }
        resolve(reason);
      };
      sub = player.addListener('playbackStatusUpdate', (st) => {
        if (st.didJustFinish) {
          done('finished');
          return;
        }
        // loaded && !playing && currentTime > 0 = playback halted mid-clip
        // (user stop, or — in app mode — the native pause on background).
        if (st.isLoaded && !st.playing && st.currentTime > 0) {
          done('stopped');
        }
      });
    });
  }

    async function runPlay(startSurahIndex, startVerseIndex, mode) {
      console.log(
        'runPlay START, mode:',
        mode,
        'from surah:',
        startSurahIndex,
        'verse:',
        startVerseIndex
      );

      let appStateSubscription = null;
      let screenStateSubscription = null;
      let userLeaveSubscription = null;

      const myToken = ++playTokenRef.current;

      const isAppMode = mode === 'app';
      const isBackgroundMode = mode === 'background';
      const isLockMode = mode === 'lock';

      let player = null;

      // One-player guarantee: starting the JS player must release any
      // native Quran playback first.
      if (nativeRunActiveRef.current) {
        nativeRunActiveRef.current = false;
        try {
          await QuranPlayer.stop();
          await QuranPlayer.release();
        } catch (_) {}
      }

      try {
        ScreenState?.setQuranPlaybackMode(mode);
      } catch (_) {}

      const stopThisRun = () => {
        if (
          myToken !== playTokenRef.current ||
          !quranPlayingRef.current
        ) {
          return;
        }

        intentionallyStoppedRef.current = true;

        // Invalidate before stopping so stale completion/fetch work
        // cannot advance playback.
        playTokenRef.current += 1;
        quranPlayingRef.current = false;

        if (soundRef.current === player) {
          stopActivePlayer(soundRef);
        }

        if (isMountedRef.current) {
          setIsPlayingQuran(false);
        }
      };

      activeStopRef.current = stopThisRun;

      try {
        quranPlayingRef.current = true;
        intentionallyStoppedRef.current = false;

        /*
        * IN APP ONLY
        *
        * Leaving Bushrann for ANY reason stops playback.
        *
        * Lock Screen mode deliberately does NOT make its decision
        * here anymore. Doing that created the AppState/SCREEN_OFF
        * ordering race.
        */
        appStateSubscription = AppState.addEventListener(
          'change',
          (state) => {
            if (myToken !== playTokenRef.current) return;

            if (state !== 'active') {
              if (isAppMode) {
                stopThisRun();
              }
            } else if (intentionallyStoppedRef.current) {
              try {
                soundRef.current?.pause();
              } catch (_) {}
            }
          }
        );

        if (ScreenState) {
          const emitter = new NativeEventEmitter(ScreenState);

          /*
          * BACKGROUND MODE
          *
          * Switching apps is allowed.
          * Physical screen-off is not.
          */
          screenStateSubscription = emitter.addListener(
            'BushrannScreenStateChanged',
            (isOn) => {
              if (myToken !== playTokenRef.current) return;

              if (isBackgroundMode && !isOn) {
                stopThisRun();
              }
            }
          );

          /*
          * LOCK SCREEN MODE
          *
          * onUserLeaveHint() means the user intentionally left
          * Bushrann while interacting with the device.
          *
          * Screen-off itself does NOT trigger this JS stop path,
          * allowing expo-audio's native background playback to
          * continue while the display is off.
          */
          userLeaveSubscription = emitter.addListener(
            'BushrannUserLeave',
            () => {
              if (myToken !== playTokenRef.current) return;

              if (isLockMode) {
                stopThisRun();
              }
            }
          );
        }

        if (isMountedRef.current) {
          setIsPlayingQuran(true);
        }

        await setAudioModeAsync({
          playsInSilentMode: true,
          shouldPlayInBackground: !isAppMode,
          interruptionMode: isAppMode ? 'duckOthers' : 'doNotMix',
        });

        // One player reused for Bismillah + Quran verses.
        player = createAudioPlayer(null);
        soundRef.current = player;

        if (!isAppMode) {
          try {
            player.setActiveForLockScreen(
              true,
              {
                title: RECITER_NAME,
                artist: RECITER_NAME,
              },
              {
                showSeekForward: false,
                showSeekBackward: false,
              }
            );
          } catch (_) {}
        }

        const allSurahs = surahsRef.current;

        for (
          let s = startSurahIndex;
          s < allSurahs.length;
          s++
        ) {
          if (
            !quranPlayingRef.current ||
            myToken !== playTokenRef.current
          ) {
            break;
          }

          const surah = allSurahs[s];

          let verses;

          try {
            verses = await fetchVerses(surah.id);
            console.log(
              'Surah',
              surah.id,
              'verses:',
              verses?.length
            );
          } catch (e) {
            console.log('fetchVerses failed:', e.message);
            continue;
          }

          if (
            myToken !== playTokenRef.current ||
            !quranPlayingRef.current
          ) {
            break;
          }

          const startV =
            s === startSurahIndex
              ? startVerseIndex
              : 0;

          // Set when a verse is paused/stopped mid-playback (not natural
          // completion) — halts the whole run without advancing.
          let stoppedMidVerse = false;

          // Bismillah except Al-Fatihah and At-Tawbah.
          if (
            startV === 0 &&
            surah.id !== 1 &&
            surah.id !== 9
          ) {
            try {
              const bismillahUrl =
                await fetchVerseAudioUrl('1:1');

              if (
                myToken !== playTokenRef.current ||
                !quranPlayingRef.current
              ) {
                break;
              }

              player.replace({
                uri: bismillahUrl,
              });

              if (!isAppMode) {
                try {
                  player.updateLockScreenMetadata({
                    title: `${surah.name_simple} — 1:1`,
                    artist: RECITER_NAME,
                  });
                } catch (_) {}
              }

              player.play();

              await playAudioUntilDone(player);
            } catch (e) {
              console.log(
                'Bismillah error:',
                e.message
              );
            }

            if (
              !quranPlayingRef.current ||
              myToken !== playTokenRef.current
            ) {
              if (isMountedRef.current) {
                await AsyncStorage.setItem(
                  'quran_resume_position',
                  JSON.stringify({
                    surahIndex: s,
                    verseIndex: 0,
                    surahName: surah.name_simple,
                  })
                );

                setResumePosition({
                  surahIndex: s,
                  verseIndex: 0,
                  surahName: surah.name_simple,
                });
              }

              break;
            }
          }

          for (
            let i = startV;
            i < verses.length;
            i++
          ) {
            if (
              !quranPlayingRef.current ||
              myToken !== playTokenRef.current
            ) {
              if (isMountedRef.current) {
                await AsyncStorage.setItem(
                  'quran_resume_position',
                  JSON.stringify({
                    surahIndex: s,
                    verseIndex: i,
                    surahName: surah.name_simple,
                  })
                );

                setResumePosition({
                  surahIndex: s,
                  verseIndex: i,
                  surahName: surah.name_simple,
                });
              }

              break;
            }

            const verseKey = verses[i].verse_key;
            const url =
              await fetchVerseAudioUrl(verseKey);

            console.log(
              'Playing verse:',
              verseKey,
              'URL:',
              url
            );

            if (
              myToken !== playTokenRef.current ||
              !quranPlayingRef.current
            ) {
              if (isMountedRef.current) {
                await AsyncStorage.setItem(
                  'quran_resume_position',
                  JSON.stringify({
                    surahIndex: s,
                    verseIndex: i,
                    surahName: surah.name_simple,
                  })
                );

                setResumePosition({
                  surahIndex: s,
                  verseIndex: i,
                  surahName: surah.name_simple,
                });
              }

              break;
            }

            try {
              player.replace({
                uri: url,
              });

              if (!isAppMode) {
                try {
                  player.updateLockScreenMetadata({
                    title: `${surah.name_simple} — ${verseKey}`,
                    artist: RECITER_NAME,
                  });
                } catch (_) {}
              }

              player.play();

              if (
                myToken !== playTokenRef.current ||
                !quranPlayingRef.current
              ) {
                break;
              }

              const reason =
                await playAudioUntilDone(player);

              console.log(
                'Audio ended:',
                reason,
                'for verse',
                verseKey
              );

              if (
                !quranPlayingRef.current ||
                myToken !== playTokenRef.current
              ) {
                if (isMountedRef.current) {
                  await AsyncStorage.setItem(
                    'quran_resume_position',
                    JSON.stringify({
                      surahIndex: s,
                      verseIndex: i,
                      surahName: surah.name_simple,
                    })
                  );

                  setResumePosition({
                    surahIndex: s,
                    verseIndex: i,
                    surahName: surah.name_simple,
                  });
                }

                break;
              }

              // A mid-verse pause/stop (NOT natural completion)
              // must not advance to the next verse or surah. Save
              // the position and halt the run cleanly instead.
              if (reason !== 'finished') {
                stoppedMidVerse = true;

                if (isMountedRef.current) {
                  await AsyncStorage.setItem(
                    'quran_resume_position',
                    JSON.stringify({
                      surahIndex: s,
                      verseIndex: i,
                      surahName: surah.name_simple,
                    })
                  );

                  setResumePosition({
                    surahIndex: s,
                    verseIndex: i,
                    surahName: surah.name_simple,
                  });
                }

                break;
              }
            } catch (audioError) {
              console.log(
                'Audio error:',
                audioError.message
              );

              continue;
            }
          }

          if (
            stoppedMidVerse ||
            !quranPlayingRef.current ||
            myToken !== playTokenRef.current
          ) {
            break;
          }
        }

        if (appStateSubscription) {
          appStateSubscription.remove();
        }

        if (screenStateSubscription) {
          screenStateSubscription.remove();
        }

        if (userLeaveSubscription) {
          userLeaveSubscription.remove();
        }

        // Only the current run may clean up shared audio state.
        if (myToken === playTokenRef.current) {
          quranPlayingRef.current = false;
          activeStopRef.current = null;

          try {
            ScreenState?.setQuranPlaybackMode(null);
          } catch (_) {}

          if (isMountedRef.current) {
            setIsPlayingQuran(false);
          }

          if (soundRef.current === player) {
            stopActivePlayer(soundRef);
          }

          try {
            await setAudioModeAsync({
              shouldPlayInBackground: false,
              interruptionMode: 'duckOthers',
            });
          } catch (_) {}
        } else {
          // Stale run: release only its own player.
          releasePlayer(player);
        }
      } catch (e) {
        if (appStateSubscription) {
          appStateSubscription.remove();
        }

        if (screenStateSubscription) {
          screenStateSubscription.remove();
        }

        if (userLeaveSubscription) {
          userLeaveSubscription.remove();
        }

        console.log(
          'runPlay error:',
          e.message
        );

        if (myToken === playTokenRef.current) {
          quranPlayingRef.current = false;
          activeStopRef.current = null;

          try {
            ScreenState?.setQuranPlaybackMode(null);
          } catch (_) {}

          if (isMountedRef.current) {
            setIsPlayingQuran(false);
          }

          if (soundRef.current === player) {
            stopActivePlayer(soundRef);
          }
        } else {
          releasePlayer(player);
        }
      }
    }

  /*
   * BACKGROUND / LOCK SCREEN MODES (native QuranPlayer).
   *
   * The native queue (Stage 2) is the playback authority: it advances
   * verse → verse → surah, injects Bismillah, persists state, and owns
   * the MediaSession. JS listeners below are for UI/resume sync only and
   * are never required for playback progression.
   */
  async function runNativePlay(startSurahIndex, startVerseIndex, mode) {
    if (!QuranPlayer) return;

    const myToken = ++playTokenRef.current;
    const isBackgroundMode = mode === 'background';
    const isLockMode = mode === 'lock';

    let appStateSubscription = null;
    let screenStateSubscription = null;
    let userLeaveSubscription = null;
    let nativeSubscriptions = [];

    const removeSubscriptions = () => {
      if (appStateSubscription) {
        appStateSubscription.remove();
        appStateSubscription = null;
      }
      if (screenStateSubscription) {
        screenStateSubscription.remove();
        screenStateSubscription = null;
      }
      if (userLeaveSubscription) {
        userLeaveSubscription.remove();
        userLeaveSubscription = null;
      }
      nativeSubscriptions.forEach((sub) => {
        try {
          sub.remove();
        } catch (_) {}
      });
      nativeSubscriptions = [];
    };

    // Mirror the native playback authority into the existing
    // quran_resume_position format. Native remains authoritative for
    // in-verse positionMs; the JS resume stores surah/verse only.
    const persistResumeFromNative = async () => {
      const st = await nativeCall('getPlaybackState');
      if (!st) return;
      nativeStateRef.current = st;
      if (st.ended) {
        await AsyncStorage.removeItem('quran_resume_position');
        if (isMountedRef.current) setResumePosition(null);
        return;
      }
      const resume = nativeStateToResume(st, surahsRef.current);
      if (resume) {
        await AsyncStorage.setItem(
          'quran_resume_position',
          JSON.stringify(resume)
        );
        if (isMountedRef.current) setResumePosition(resume);
      }
    };

    const finishNativeRun = () => {
      removeSubscriptions();
      if (myToken === playTokenRef.current) {
        activeStopRef.current = null;
        quranPlayingRef.current = false;
        nativeRunActiveRef.current = false;
        try {
          ScreenState?.setQuranPlaybackMode(null);
        } catch (_) {}
        if (isMountedRef.current) setIsPlayingQuran(false);
      }
    };

    const stopThisRun = () => {
      if (
        myToken !== playTokenRef.current ||
        !quranPlayingRef.current
      ) {
        return;
      }

      intentionallyStoppedRef.current = true;
      playTokenRef.current += 1;
      quranPlayingRef.current = false;
      nativeRunActiveRef.current = false;

      // Pause the native player at the exact item, persist its state,
      // then release the service/notification.
      nativeCall('stop').then(() => nativeCall('release'));
      persistResumeFromNative();
      removeSubscriptions();

      try {
        ScreenState?.setQuranPlaybackMode(null);
      } catch (_) {}

      activeStopRef.current = null;
      if (isMountedRef.current) setIsPlayingQuran(false);
    };

    activeStopRef.current = stopThisRun;

    try {
      quranPlayingRef.current = true;
      intentionallyStoppedRef.current = false;
      nativeRunActiveRef.current = true;

      try {
        ScreenState?.setQuranPlaybackMode(mode);
      } catch (_) {}

      // One-player guarantee: release the JS/expo-audio player first.
      stopActivePlayer(soundRef);

      // Flat verse list from the selected surah/verse to 114:6. Native
      // code only reads items[startIndex] and then extends the window
      // itself from the verse table (including Bismillah prefixes).
      const allSurahs = surahsRef.current;
      const items = [];
      for (let s = startSurahIndex; s < allSurahs.length; s++) {
        const firstVerse =
          s === startSurahIndex ? startVerseIndex + 1 : 1;
        for (let v = firstVerse; v <= allSurahs[s].verses_count; v++) {
          items.push(`${allSurahs[s].id}:${v}`);
        }
      }

      if (items.length === 0) {
        finishNativeRun();
        return;
      }

      if (isMountedRef.current) setIsPlayingQuran(true);

      // Foreground sync + resume persistence around lifecycle changes.
      appStateSubscription = AppState.addEventListener(
        'change',
        (state) => {
          if (myToken !== playTokenRef.current) return;
          if (state === 'active') {
            if (intentionallyStoppedRef.current) return;
            // Returning from background/lock screen: adopt the actual
            // native verse/position and playing state.
            (async () => {
              const st = await nativeCall('getPlaybackState');
              if (
                myToken !== playTokenRef.current ||
                !st ||
                st.ended
              ) {
                return;
              }
              nativeStateRef.current = st;
              if (isMountedRef.current) {
                setIsPlayingQuran(!!st.isPlaying);
              }
              await persistResumeFromNative();
            })();
          } else {
            // Backgrounding: persist the authoritative position while JS
            // is still awake. No polling — native owns progression.
            persistResumeFromNative();
          }
        }
      );

      if (ScreenState) {
        const emitter = new NativeEventEmitter(ScreenState);

        // BACKGROUND MODE: physical screen-off stops playback (existing
        // policy). Native advances on its own while the screen is on.
        screenStateSubscription = emitter.addListener(
          'BushrannScreenStateChanged',
          (isOn) => {
            if (myToken !== playTokenRef.current) return;
            if (isBackgroundMode && !isOn) stopThisRun();
          }
        );

        // LOCK SCREEN MODE: the user intentionally leaving the app stops
        // playback; screen-off keeps native playback going.
        userLeaveSubscription = emitter.addListener(
          'BushrannUserLeave',
          () => {
            if (myToken !== playTokenRef.current) return;
            if (isLockMode) stopThisRun();
          }
        );
      }

      // Native event listeners — installed once per run, removed in
      // removeSubscriptions(). All guarded by the run token.
      if (QuranPlayer) {
        const emitter = new NativeEventEmitter(QuranPlayer);

        nativeSubscriptions.push(
          emitter.addListener(NATIVE_EVENTS.trackChanged, (st) => {
            if (myToken !== playTokenRef.current) return;
            nativeStateRef.current = {
              ...nativeStateRef.current,
              ...st,
            };
          })
        );

        nativeSubscriptions.push(
          emitter.addListener(NATIVE_EVENTS.state, (st) => {
            if (myToken !== playTokenRef.current) return;
            nativeStateRef.current = {
              ...nativeStateRef.current,
              ...st,
            };
            if (isMountedRef.current && st && !st.ended) {
              setIsPlayingQuran(!!st.isPlaying);
            }
          })
        );

        // NEVER skip on error: native already paused at the exact verse
        // and persisted it. Surface the error and offer a retry of the
        // SAME item via native resume().
        nativeSubscriptions.push(
          emitter.addListener(NATIVE_EVENTS.error, (err) => {
            if (myToken !== playTokenRef.current) return;
            persistResumeFromNative();
            if (isMountedRef.current) setIsPlayingQuran(false);
            Alert.alert(
              'Playback Error',
              `Playback paused at ${err?.verseKey ?? 'the current verse'}.\n\n${err?.message ?? 'Unknown playback error'}`,
              [
                {
                  text: 'Stop',
                  style: 'cancel',
                  onPress: () => stopThisRun(),
                },
                {
                  text: 'Retry',
                  onPress: () => {
                    if (myToken !== playTokenRef.current) return;
                    nativeCall('resume');
                    if (isMountedRef.current) {
                      setIsPlayingQuran(true);
                    }
                  },
                },
              ]
            );
          })
        );

        // Natural final completion at 114:6.
        nativeSubscriptions.push(
          emitter.addListener(NATIVE_EVENTS.ended, () => {
            if (myToken !== playTokenRef.current) return;
            (async () => {
              try {
                await AsyncStorage.removeItem(
                  'quran_resume_position'
                );
              } catch (_) {}
              if (isMountedRef.current) setResumePosition(null);
              finishNativeRun();
            })();
          })
        );
      }

      // loadQueue starts native playback immediately.
      const st = await nativeCall(
        'loadQueue',
        items,
        0,
        0,
        RECITER_NAME
      );
      if (st) nativeStateRef.current = st;

      if (myToken !== playTokenRef.current) return;
    } catch (e) {
      console.log('runNativePlay error:', e.message);
      nativeCall('stop').then(() => nativeCall('release'));
      persistResumeFromNative();
      finishNativeRun();
    }
  }

  function playEntireQuran(startSurahIndex = 0, startVerseIndex = 0) {
    if (surahs.length === 0) return;

    if (isPlayingQuran) {
      // Let the active run stop itself (JS or native) so mode-specific
      // cleanup — especially native stop/persist/release — happens there.
      const stopActive = activeStopRef.current;
      if (stopActive) stopActive();

      playTokenRef.current += 1;
      quranPlayingRef.current = false;
      intentionallyStoppedRef.current = true;
      stopActivePlayer(soundRef);

      try {
        ScreenState?.setQuranPlaybackMode(null);
      } catch (_) {}

      if (isMountedRef.current) setIsPlayingQuran(false);
      return;
    }

    const si = typeof startSurahIndex === 'number' ? startSurahIndex : 0;
    const vi = typeof startVerseIndex === 'number' ? startVerseIndex : 0;

    setPendingPlayParams({ si, vi });
    setPlaybackDialogVisible(true);
  }

  function handleModeSelect(mode) {
    const { si, vi } = pendingPlayParams;
    if (mode === 'app') {
      runPlay(si, vi, mode);
    } else {
      runNativePlay(si, vi, mode);
    }
  }

  const handleSearch = useCallback(
    (text) => {
      setSearch(text);
      if (!text.trim()) {
        setFiltered(surahs);
        return;
      }
      const q = text.toLowerCase();
      setFiltered(
        surahs.filter(
          (s) =>
            s.name_simple.toLowerCase().includes(q) ||
            s.translated_name?.name?.toLowerCase().includes(q) ||
            String(s.id).includes(q)
        )
      );
    },
    [surahs]
  );

  const renderSurah = useCallback(({ item }) => (
    <TouchableOpacity
      style={styles.surahRow}
      onPress={() => navigation.navigate('QuranReader', { surah: item })}
      activeOpacity={0.75}
    >
      <View style={styles.numberBadge}>
        <Text style={styles.numberText}>{item.id}</Text>
      </View>
      <View style={styles.surahInfo}>
        <Text style={styles.surahName}>{item.name_simple}</Text>
        <Text style={styles.surahMeta}>
          {item.translated_name?.name} · {item.verses_count} verses
        </Text>
      </View>
      <View style={styles.surahRight}>
        <Text style={styles.arabicName}>{item.name_arabic}</Text>
        <Text style={[styles.revelationType, { color: REVELATION_COLORS[item.revelation_place] ?? '#888' }]}>
          {item.revelation_place}
        </Text>
      </View>
    </TouchableOpacity>
  ), []);

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color="#000" />
        </TouchableOpacity>

        <View>
          <Text style={styles.headerTitle}>Al-Quran</Text>
          <Text style={styles.headerSub}>Read · Memorize · Recite</Text>
        </View>
        <TouchableOpacity
          onPress={() => playEntireQuran()}
          disabled={loading || surahs.length === 0}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: isPlayingQuran ? '#e53935' : COLORS.gold,
            paddingHorizontal: 10,
            paddingVertical: 6,
            borderRadius: 16,
            opacity: (loading || surahs.length === 0) ? 0.5 : 1,
          }}
        >
          <Ionicons name={isPlayingQuran ? 'stop' : 'play'} size={14} color="#000" />
          <Text style={{ color: '#000', fontWeight: '700', fontSize: 12, marginLeft: 4 }}>
            {isPlayingQuran ? 'Stop' : 'Play All'}
          </Text>
        </TouchableOpacity>
      </View>

      {resumePosition && !isPlayingQuran && (
        <TouchableOpacity
          onPress={() => playEntireQuran(resumePosition.surahIndex, resumePosition.verseIndex)}
          style={styles.resumeBanner}
        >
          <Ionicons name="play-circle" size={20} color="#000" />
          <Text style={styles.resumeText}>Continue from {resumePosition.surahName}</Text>
          <TouchableOpacity onPress={async () => {
            await AsyncStorage.removeItem('quran_resume_position');
            if (isMountedRef.current) setResumePosition(null);
          }}>
            <Ionicons name="close-circle" size={18} color="#666" />
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#aaa" style={{ marginRight: 8 }} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search surah name or number..."
          placeholderTextColor="#888"
          value={search}
          onChangeText={handleSearch}
          returnKeyType="search"
        />
        {search.length > 0 && (
          <TouchableOpacity onPress={() => handleSearch('')}>
            <Ionicons name="close-circle" size={18} color="#aaa" />
          </TouchableOpacity>
        )}
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.gold} size="large" />
          <Text style={styles.loadingText}>Loading surahs...</Text>
        </View>
      ) : error ? (
        <View style={styles.center}>
          <Ionicons name="wifi-outline" size={48} color="#555" />
          <Text style={styles.errorText}>{error}</Text>
          <TouchableOpacity style={styles.retryBtn} onPress={loadSurahs}>
            <Text style={styles.retryText}>Try Again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(item) => String(item.id)}
          renderItem={renderSurah}
          contentContainerStyle={{ paddingBottom: insets.bottom + 80 }}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          initialNumToRender={isLowEndDevice ? 8 : 15}
          maxToRenderPerBatch={isLowEndDevice ? 8 : 15}
          windowSize={isLowEndDevice ? 5 : 21}
        />
      )}

      <PlaybackModeDialog
        visible={playbackDialogVisible}
        onSelect={handleModeSelect}
        onDismiss={() => setPlaybackDialogVisible(false)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#ffffff' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTitle: { color: '#000', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  headerSub: { color: '#666', fontSize: 12, textAlign: 'center', marginTop: 2 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: '#f5f5f5',
    margin: 12, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
  },
  searchInput: { flex: 1, color: '#000', fontSize: 14, padding: 0 },
  surahRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 14 },
  numberBadge: {
    width: 40, height: 40, borderRadius: 20, backgroundColor: '#f5f5f5',
    alignItems: 'center', justifyContent: 'center', marginRight: 14,
  },
  numberText: { color: COLORS.gold ?? '#c9a84c', fontSize: 13, fontWeight: '700' },
  surahInfo: { flex: 1 },
  surahName: { color: '#000', fontSize: 15, fontWeight: '600' },
  surahMeta: { color: '#666', fontSize: 12, marginTop: 3 },
  surahRight: { alignItems: 'flex-end' },
  arabicName: { color: '#000', fontSize: 18, fontWeight: '500' },
  revelationType: { fontSize: 11, marginTop: 4, fontWeight: '500' },
  separator: { height: 1, backgroundColor: 'rgba(255,255,255,0.05)', marginHorizontal: 16 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  loadingText: { color: '#666', fontSize: 14, marginTop: 12 },
  errorText: { color: '#666', fontSize: 14, textAlign: 'center', paddingHorizontal: 32, marginBottom: 12 },
  retryBtn: { marginTop: 12, backgroundColor: COLORS.gold ?? '#c9a84c', paddingHorizontal: 24, paddingVertical: 10, borderRadius: 20 },
  retryText: { color: '#000', fontWeight: '700', fontSize: 14 },
  resumeBanner: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: COLORS.gold ?? '#c9a84c',
    marginHorizontal: 12, marginBottom: 4, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10,
  },
  resumeText: { flex: 1, color: '#000', fontWeight: '600', fontSize: 13, marginLeft: 8 },
});
