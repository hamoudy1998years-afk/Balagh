import { View, Text, StyleSheet, TextInput, ScrollView, KeyboardAvoidingView, Platform, Image } from 'react-native';
import { useState, useEffect, useRef, useCallback } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { SystemBars } from 'react-native-edge-to-edge';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';
import { readAsStringAsync, deleteAsync, copyAsync, cacheDirectory, getInfoAsync } from 'expo-file-system/legacy';
import { File as ExpoFile } from 'expo-file-system';
import { supabase } from '../lib/supabase';
import AnimatedButton from './AnimatedButton';
import { userCache } from '../utils/userCache';
import { COLORS } from '../constants/theme';
import { ROUTES } from '../constants/routes';
import { Linking } from 'react-native';
import ModernDialog from './ModernDialog';
import { decode } from 'base64-arraybuffer';
import { useUser } from '../context/UserContext';
import * as Sentry from '@sentry/react-native';
import * as tus from 'tus-js-client';
// TODO: Install expo-video-manipulator for video compression
// npm install expo-video-manipulator

const CATEGORIES = ['Quran', 'Hadith', 'Reminder', 'Lecture', 'Nasheeds', 'Dua', 'Other'];
const SERVER_URL = process.env.EXPO_PUBLIC_SERVER_URL;
const sanitize = (text) => text.replace(/<[^>]*>/g, '').trim();

// Minimal custom TUS FileReader that uses expo-file-system's modern synchronous
// FileHandle.readBytes() API instead of tus-js-client's default uriToBlob() path,
// which performs an XMLHttpRequest GET that fails on Android file:// URIs.
class ExpoFileReader {
  constructor(onSourceCreated) {
    this.onSourceCreated = onSourceCreated;
  }

  async openFile(input, _chunkSize) {
    const file = new ExpoFile(input.uri);
    const handle = file.open();
    const source = new ExpoFileSource(handle, input.size);
    this.onSourceCreated?.(source);
    return source;
  }
}

class ExpoFileSource {
  constructor(handle, size) {
    this.handle = handle;
    this.size = size;
  }

  async slice(start, end) {
    if (end > this.size) end = this.size;
    this.handle.offset = start;
    const value = this.handle.readBytes(Math.max(0, end - start));
    // TUS checks value.size when validating upload size; Uint8Array has no size.
    value.size = value.byteLength;
    return { value, done: end >= this.size };
  }

  close() {
    try {
      this.handle.close();
    } catch (e) {}
  }
}

export default function UploadScreen({ navigation }) {
  const insets = useSafeAreaInsets();
  const { user: authUser } = useUser();
  const [video, setVideo] = useState(null);
  const [thumbnailUri, setThumbnailUri] = useState(null); // NEW: store thumbnail preview
  const [generatingThumb, setGeneratingThumb] = useState(false); // NEW: loading state
  const [caption, setCaption] = useState('');
  const [category, setCategory] = useState('');
  const [uploading, setUploading] = useState(false);
  const [isScholar, setIsScholar] = useState(null);
  const [isTrusted, setIsTrusted] = useState(false);
  const [isBanned, setIsBanned] = useState(null);
  const [scholarChecked, setScholarChecked] = useState(false);
  const [progressPercent, setProgressPercent] = useState(0);
  const [progressLabel, setProgressLabel] = useState('');

  const [showLiveSetup, setShowLiveSetup] = useState(false);
  const [liveTitle, setLiveTitle] = useState('');
  const [maxQuestions, setMaxQuestions] = useState('5');

  const [dialog, setDialog] = useState({
    visible: false,
    title: '',
    message: '',
    type: 'info',
    buttons: []
  });

  const scrollRef = useRef(null);
  const isUploadingRef = useRef(false);
  const isPickingRef = useRef(false);
  const activeCheckIdRef = useRef(0);
  const thumbnailGenIdRef = useRef(0);
  const activeTusUploadRef = useRef(null);

  // Track the current upload's FileSource so the native FileHandle can be closed
  // on error, abort, or unmount, even if tus-js-client does not close it.
  const activeVideoSourceRef = useRef(null);

  // SHOULD-FIX: track the current thumbnail temp-file URI in a ref (mirrors
  // thumbnailUri state) so it can be cleaned up on unmount even if the user
  // picks a video, gets a thumbnail generated, and then navigates away
  // without ever uploading.
  const thumbnailUriRef = useRef(null);
  useEffect(() => { thumbnailUriRef.current = thumbnailUri; }, [thumbnailUri]);

  // Track the current app-owned temporary video copy so it can be cleaned up
  // on unmount if an upload is abandoned before cleanup runs in the upload flow.
  const tempVideoUriRef = useRef(null);

  useEffect(() => {
    return () => {
      // Snapshot and clear refs immediately so stale callbacks cannot clear
      // newer ownership, then abort any active TUS upload before closing its
      // FileHandle and deleting its source file to avoid the uploader reading a
      // file that is being removed mid-flight.
      const activeUpload = activeTusUploadRef.current;
      const activeSource = activeVideoSourceRef.current;
      const tempUri = tempVideoUriRef.current;
      activeTusUploadRef.current = null;
      activeVideoSourceRef.current = null;
      tempVideoUriRef.current = null;

      if (thumbnailUriRef.current) {
        deleteAsync(thumbnailUriRef.current, { idempotent: true }).catch(() => {});
      }

      if (activeUpload) {
        activeUpload
          .abort(false)
          .catch(() => {})
          .finally(() => {
            activeSource?.close();
            if (tempUri) {
              deleteAsync(tempUri, { idempotent: true }).catch(() => {});
            }
          });
      } else {
        activeSource?.close();
        if (tempUri) {
          deleteAsync(tempUri, { idempotent: true }).catch(() => {});
        }
      }
    };
  }, []);

  // SHOULD-FIX: guard against calling React state setters after the screen
  // has unmounted while the async upload flow (TUS upload, thumbnail read,
  // DB insert) is still in flight.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  useFocusEffect(
    useCallback(() => {
      scrollRef.current?.scrollTo({ y: 0, animated: false });
      // Dark icons for light/white background
      const entry = SystemBars.pushStackEntry({ style: 'dark' });
      return () => {
        SystemBars.popStackEntry(entry);
      };
    }, [])
  );

  const checkIfScholarInstant = useCallback(async () => {
    const checkId = ++activeCheckIdRef.current;

    const cached = await userCache.get();
    if (activeCheckIdRef.current !== checkId) return;

    if (cached?.is_scholar !== undefined) {
      setIsScholar(cached.is_scholar);
    }
    if (cached?.trusted_user !== undefined) {
      setIsTrusted(cached.trusted_user);
    }
    if (cached?.is_banned !== undefined) {
      setIsBanned(cached.is_banned);
    }

    const user = authUser;
    if (!user) {
      if (activeCheckIdRef.current !== checkId) return;
      setIsScholar(false);
      setIsTrusted(false);
      setIsBanned(false);
      setScholarChecked(true);
      return;
    }

    const { data, error } = await supabase
      .from('profiles')
      .select('is_scholar, trusted_user, is_banned')
      .eq('id', user.id)
      .single();

    if (activeCheckIdRef.current !== checkId) return;

    if (error || !data) {
      // Fail closed: if the profile check itself failed, we don't know the
      // user's real ban status, so leave isBanned as null (unresolved) and
      // scholarChecked as false rather than defaulting to "not banned".
      setIsScholar(null);
      setIsTrusted(false);
      setIsBanned(null);
      setScholarChecked(false);
      return;
    }

    setIsScholar(data.is_scholar ?? false);
    setIsTrusted(data.trusted_user ?? false);
    setIsBanned(data.is_banned ?? false);
    setScholarChecked(true);
  }, [authUser]);

  useEffect(() => { checkIfScholarInstant(); }, [checkIfScholarInstant]);

  // NEW: Compress video before upload
  // NOTE: Real compression is not implemented yet (expo-video-manipulator
  // is not installed). This intentionally does nothing but return the
  // original URI — no fake delay, no `compressing` state, so the UI never
  // implies a preparation step that isn't actually happening.
  // TODO: Use expo-video-manipulator when installed, e.g.:
  // import { VideoManipulator } from 'expo-video-manipulator';
  // const compressed = await VideoManipulator.compress(uri, {
  //   quality: 'medium',
  //   maxResolution: 1080,
  // });
  const compressVideo = useCallback(async (uri, fileSize) => {
    return uri;
  }, []);

  // NEW: Generate thumbnail when video is selected
  const generateThumbnailPreview = useCallback(async (videoUri) => {
    const genId = ++thumbnailGenIdRef.current;
    try {
      setGeneratingThumb(true);

      // Best-effort cleanup of the previous thumbnail temp file before
      // generating a new one, so re-picking a video doesn't leak temp files.
      if (thumbnailUri) {
        deleteAsync(thumbnailUri, { idempotent: true }).catch(() => {});
      }

      const { uri } = await VideoThumbnails.getThumbnailAsync(
        videoUri,
        { time: 1000, quality: 0.8 }
      );

      if (thumbnailGenIdRef.current !== genId) {
        // A newer selection started after this one; this result is stale.
        // Discard it and clean up the file it generated so it doesn't leak.
        deleteAsync(uri, { idempotent: true }).catch(() => {});
        return;
      }

      setThumbnailUri(uri);
    } catch (error) {
      __DEV__ && console.error('Thumbnail generation failed:', error);
      if (thumbnailGenIdRef.current === genId) {
        setThumbnailUri(null);
      }
    } finally {
      if (thumbnailGenIdRef.current === genId) {
        setGeneratingThumb(false);
      }
    }
  }, [thumbnailUri]); // dependency added so the closure sees the latest thumbnailUri

  const pickVideo = useCallback(async () => {
    if (isPickingRef.current) return;
    isPickingRef.current = true;

    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (status !== 'granted') {
        setDialog({
          visible: true,
          title: 'Permission Required',
          message: 'Bushrann needs access to your gallery to upload videos.',
          type: 'warning',
          buttons: [
            { text: 'Not Now', style: 'cancel' },
            { text: 'Open Settings', onPress: () => Linking.openSettings() },
          ]
        });
        return;
      }

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        allowsEditing: false,
        quality: 1,
      });

      if (!result.canceled) {
        // Check file size (500MB max)
        if (result.assets[0].fileSize > 500 * 1024 * 1024) {
          setDialog({
            visible: true,
            title: 'File Too Large',
            message: 'Maximum file size is 500MB. Please select a shorter video.',
            type: 'warning',
            buttons: [{ text: 'OK' }]
          });
          return;
        }

        if (result.assets[0].fileSize > 150 * 1024 * 1024) {
          setDialog({
            visible: true,
            title: 'Large File Warning ⚠️',
            message: 'This video is over 150MB. Upload may take a while depending on your WiFi or mobile data speed. You can still proceed.',
            type: 'warning',
            buttons: [
              { text: 'Cancel', style: 'cancel' },
              {
                text: 'Continue Anyway',
                onPress: async () => {
                  const compressedUri = await compressVideo(
                    result.assets[0].uri,
                    result.assets[0].fileSize
                  );

                  setVideo({
                    ...result.assets[0],
                    uri: compressedUri
                  });

                  await generateThumbnailPreview(compressedUri);
                }
              }
            ]
          });
          return;
        }

        // NEW: Compress video if needed
        const compressedUri = await compressVideo(
          result.assets[0].uri,
          result.assets[0].fileSize
        );

        setVideo({
          ...result.assets[0],
          uri: compressedUri
        });

        // NEW: Generate thumbnail immediately after selection
        await generateThumbnailPreview(compressedUri);
      }
    } catch (error) {
      __DEV__ && console.error('Video picker failed:', error);

      if (isMountedRef.current) {
        setDialog({
          visible: true,
          title: 'Unable to Open Gallery',
          message: 'Could not open your video library. Please try again.',
          type: 'error',
          buttons: [{ text: 'OK' }],
        });
      }
    } finally {
      isPickingRef.current = false;
    }
  }, [generateThumbnailPreview, compressVideo]);

  const uploadVideo = useCallback(async () => {
    if (isUploadingRef.current) return;
    isUploadingRef.current = true;

    try {
      if (!video) {
        setDialog({
          visible: true,
          title: 'No video',
          message: 'Please pick a video first.',
          type: 'warning',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      if (!caption.trim()) {
        setDialog({
          visible: true,
          title: 'No caption',
          message: 'Please add a caption.',
          type: 'warning',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      if (!category) {
        setDialog({
          visible: true,
          title: 'No category',
          message: 'Please select a category.',
          type: 'warning',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      const MAX_SIZE = 500 * 1024 * 1024;

      if (video.fileSize && video.fileSize > MAX_SIZE) {
        setDialog({
          visible: true,
          title: 'File Too Large',
          message: 'Please select a video under 500MB.',
          type: 'warning',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      // MUST-FIX: block upload while profile/ban verification is still
      // unresolved (isBanned === null means the check hasn't completed yet).
      // Without this, a user could tap Upload before checkIfScholarInstant's
      // Supabase query returns and start uploading while their ban status is
      // still unknown.
      if (!scholarChecked || isBanned === null) {
        setDialog({
          visible: true,
          title: 'Please wait',
          message: 'Still verifying your account, try again in a moment.',
          type: 'info',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      // MUST-FIX: reject banned users before any storage upload or DB insert
      // begins. This is a client-side UX check only (saves the banned user's
      // time/bandwidth); it is NOT the security boundary. The authoritative
      // enforcement must be server-side (DB trigger + storage RLS), since a
      // modified client could skip this check entirely.
      if (isBanned) {
        setDialog({
          visible: true,
          title: 'Upload Rejected',
          message: 'You are banned from uploading videos. Contact admin for support.',
          type: 'error',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      setUploading(true);
      setProgressPercent(0);
      setProgressLabel('Uploading video...');

      let uploadedVideoPath = null;
      let uploadedThumbPath = null;
      let finalThumbnailUri = null;
      let tempVideoUri = null;
      let uploadStage = 'initializing';
      let currentUploadSource = null;

      const user = authUser;

      if (!user) {
        setDialog({
          visible: true,
          title: 'Not logged in',
          message: 'Please log in to upload videos.',
          type: 'info',
          buttons: [
            {
              text: 'OK',
              onPress: () => navigation.replace(ROUTES.LOGIN)
            }
          ]
        });

        setUploading(false);
        return;
      }

      uploadStage = 'auth_session';

      const {
        data: { session }
      } = await supabase.auth.getSession();

      if (!isMountedRef.current) return;

      if (!session) {
        setDialog({
          visible: true,
          title: 'Session expired',
          message: 'Please log in again.',
          type: 'error',
          buttons: [
            {
              text: 'OK',
              onPress: () => navigation.replace(ROUTES.LOGIN)
            }
          ]
        });

        setUploading(false);
        return;
      }

      try {
        // Use the already generated thumbnail
        uploadStage = 'thumbnail_generation';

        finalThumbnailUri =
          thumbnailUri ||
          (
            await VideoThumbnails.getThumbnailAsync(
              video.uri,
              {
                time: 1000,
                quality: 0.8
              }
            )
          ).uri;

        if (isMountedRef.current) {
          setProgressPercent(10);
        }

        // 2. UPLOAD VIDEO
        // SHOULD-FIX: Android `content://` picker URIs frequently have no
        // '.' in them at all, so a naive `.split('.').pop()` returns the
        // entire URI as the "extension" and produces a malformed storage
        // object name. Fall back to a mime-derived/default extension when
        // the URI doesn't yield a short, plausible extension.
        const rawExt = video.uri.split('.').pop();
        const mimeExt = (video.mimeType || '').split('/').pop();

        const ext =
          rawExt &&
          rawExt.length <= 5 &&
          !rawExt.includes('/') &&
          !rawExt.includes(':')
            ? rawExt
            : (
                mimeExt && mimeExt.length <= 5
                  ? mimeExt
                  : 'mp4'
              );

        const videoFileName = `${user.id}/${Date.now()}.${ext}`;
        const SUPABASE_URL = supabase.supabaseUrl;
        const contentType = video.mimeType || 'video/mp4';

        // SURGICAL FIX: Copy the selected video into the app's cache directory
        // so tus-js-client receives an accessible file:// URI instead of an
        // Android content:// URI that XMLHttpRequest cannot read as a Blob.
        // This is a native file copy; the video bytes are never loaded into JS.
        if (!cacheDirectory) {
          throw new Error('Cache directory is unavailable');
        }

        const randomSuffix = Math.random()
          .toString(36)
          .slice(2, 10);

        tempVideoUri =
          `${cacheDirectory}upload_${Date.now()}_${randomSuffix}.${ext}`;

        if (
          tempVideoUriRef.current &&
          tempVideoUriRef.current !== tempVideoUri
        ) {
          deleteAsync(
            tempVideoUriRef.current,
            { idempotent: true }
          ).catch(() => {});
        }

        uploadStage = 'video_cache_copy';

        await copyAsync({
          from: video.uri,
          to: tempVideoUri
        });

        // If the screen unmounted while the native copy was in progress, do not
        // start TUS and do not leave this upload's temp file behind.
        if (!isMountedRef.current) {
          deleteAsync(
            tempVideoUri,
            { idempotent: true }
          ).catch(() => {});
          return;
        }

        // Only register the temp file for unmount cleanup after the copy has
        // finished, so unmount cannot delete the destination while copyAsync is
        // still writing it.
        tempVideoUriRef.current = tempVideoUri;

        // SANITY CHECK: confirm the copied file is actually present and has
        // bytes before handing it to the uploader. Rules out a race/deletion
        // as the cause if this throws, instead of failing deep inside tus
        // with an opaque "[object Object]" error.
        uploadStage = 'video_file_verify';

        const copiedInfo =
          await getInfoAsync(tempVideoUri);

        if (
          !copiedInfo.exists ||
          !copiedInfo.size
        ) {
          throw new Error(
            `Copied video file is missing or empty at ${tempVideoUri}`
          );
        }

        uploadStage = 'tus_video_upload';

        await new Promise((resolve, reject) => {
          const upload = new tus.Upload(
            {
              uri: tempVideoUri,
              name: videoFileName,
              type: contentType,
              size: copiedInfo.size,
            },
            {
              endpoint:
                `${SUPABASE_URL}/storage/v1/upload/resumable`,

              fileReader:
                new ExpoFileReader((source) => {
                  // Only adopt the source if this upload is still the active one
                  // and the screen is still mounted. Otherwise close it immediately
                  // to avoid leaking a native FileHandle after unmount.
                  if (
                    !isMountedRef.current ||
                    activeTusUploadRef.current !== upload
                  ) {
                    source.close();
                    return;
                  }

                  currentUploadSource = source;
                  activeVideoSourceRef.current = source;
                }),

              retryDelays: [
                0,
                3000,
                5000,
                10000,
                20000
              ],

              headers: {
                'x-upsert': 'false',
              },

              // NEW: fetch a fresh access token before every request (including
              // chunk PATCH requests), instead of a single token captured once
              // at Upload construction. Prevents long uploads (150–500MB on
              // slow connections) from failing when the JWT expires mid-upload.
              onBeforeRequest: async (req) => {
                const {
                  data: {
                    session: freshSession
                  }
                } =
                  await supabase.auth.getSession();

                if (
                  freshSession?.access_token
                ) {
                  req.setHeader(
                    'Authorization',
                    `Bearer ${freshSession.access_token}`
                  );
                }
              },

              // NEW: a 401 caused by an expired token is retried (after
              // onBeforeRequest supplies a fresh token on the retry attempt)
              // instead of being treated as a fatal error. Both 401s and all
              // other errors share the same retry budget.
              onShouldRetry:
                (
                  err,
                  retryAttempt,
                  options
                ) => {
                  return (
                    retryAttempt <
                    options.retryDelays.length
                  );
                },

              uploadDataDuringCreation: true,
              removeFingerprintOnSuccess: true,

              // MUST-FIX: disable fingerprint-based resumption. tus-js-client's
              // fingerprint is derived from the file itself (uri/name/size/type),
              // not from objectName. Without this, a previous session's upload
              // (created with a different objectName) could be resumed here,
              // while the DB row below still records this call's newly
              // generated videoFileName — causing video_url to point to a
              // path that doesn't match where the bytes actually landed.
              storeFingerprintForResuming: false,

              metadata: {
                bucketName: 'videos',
                objectName: videoFileName,
                contentType,
                cacheControl: '3600',
              },

              chunkSize:
                6 * 1024 * 1024,

              onError: (error) => {
                if (
                  activeTusUploadRef.current ===
                  upload
                ) {
                  activeTusUploadRef.current =
                    null;
                }

                if (currentUploadSource) {
                  currentUploadSource.close();

                  if (
                    activeVideoSourceRef.current ===
                    currentUploadSource
                  ) {
                    activeVideoSourceRef.current =
                      null;
                  }

                  currentUploadSource =
                    null;
                }

                if (
                  error &&
                  typeof error === 'object'
                ) {
                  try {
                    error._uploadStage =
                      uploadStage;

                    error._tusStatus =
                      error?.originalResponse?.getStatus?.() ??
                      error?.status ??
                      error?.response?.status ??
                      null;
                  } catch (e) {}
                }

                reject(error);
              },

              onProgress: (
                bytesUploaded,
                bytesTotal
              ) => {
                const pct =
                  Math.min(
                    Math.round(
                      (
                        bytesUploaded /
                        bytesTotal
                      ) * 90
                    ) + 10,
                    99
                  );

                if (
                  isMountedRef.current
                ) {
                  setProgressPercent(pct);
                }
              },

              onSuccess: () => {
                if (
                  activeTusUploadRef.current ===
                  upload
                ) {
                  activeTusUploadRef.current =
                    null;
                }

                // Tus-js-client calls source.close() after onSuccess. Only clear
                // the shared ref if it still points to this upload's source.
                if (
                  activeVideoSourceRef.current ===
                  currentUploadSource
                ) {
                  activeVideoSourceRef.current =
                    null;
                }

                currentUploadSource = null;

                resolve();
              },
            }
          );

          activeTusUploadRef.current =
            upload;

          upload.start();
        });

        uploadedVideoPath =
          videoFileName;

        const videoUrl =
          `${SUPABASE_URL}/storage/v1/object/public/videos/${videoFileName}`;

        if (
          isMountedRef.current
        ) {
          setProgressPercent(95);
          setProgressLabel(
            'Uploading thumbnail...'
          );
        }

        // 3. UPLOAD THUMBNAIL
        uploadStage =
          'thumbnail_read';

        const thumbBase64 =
          await readAsStringAsync(
            finalThumbnailUri,
            {
              encoding: 'base64',
            }
          );

        const thumbFileName =
          `${user.id}/${Date.now()}.jpg`;

        uploadStage =
          'thumbnail_upload';

        const {
          error: thumbError
        } =
          await supabase.storage
            .from('thumbnails')
            .upload(
              thumbFileName,
              decode(thumbBase64),
              {
                contentType:
                  'image/jpeg',
                upsert: false
              }
            );

        if (thumbError) {
          throw thumbError;
        }

        uploadedThumbPath =
          thumbFileName;

        const thumbnailUrl =
          `${SUPABASE_URL}/storage/v1/object/public/thumbnails/${thumbFileName}`;

        if (
          isMountedRef.current
        ) {
          setProgressPercent(100);
          setProgressLabel('Saving...');
        }

        // 4. SAVE TO DATABASE
        // Moderation status is still decided server-side. New uploads also start
        // as `processing`, so Home/feed queries can keep the original media hidden
        // until Railway remuxes/transcodes it into an Android-safe MP4.
        //
        // `original_video_url` preserves the source object for the processor.
        // `.select('id, status')` lets us trigger Railway immediately when RLS
        // allows the uploader to read the inserted row. If SELECT is blocked
        // (PGRST116), the insert still succeeded and Railway's recovery sweeper
        // will pick up the processing row automatically.
        uploadStage =
          'database_insert';

        const {
          data: insertedVideo,
          error: dbError
        } =
          await supabase
            .from('videos')
            .insert({
              user_id: user.id,
              caption:
                sanitize(caption),
              category,
              video_url:
                videoUrl,
              original_video_url:
                videoUrl,
              processing_status:
                'processing',
              thumbnail_url:
                thumbnailUrl,
              is_private: false,
              views_count: 0,
              likes_count: 0,
            })
            .select('id, status')
            .single();

        if (
          dbError &&
          dbError.code !==
            'PGRST116'
        ) {
          throw dbError;
        }

        // Authoritative: reflects the server-computed moderation status, not
        // stale client-side isScholar/isTrusted state.
        const autoApproved =
          insertedVideo?.status ===
          'approved';

        // Best-effort immediate Railway trigger. This must NEVER turn a committed
        // upload into a failure: if the request cannot be made, the backend
        // recovery sweeper will still discover the `processing` row and process it.
        if (
          insertedVideo?.id &&
          SERVER_URL
        ) {
          try {
            let {
              data: {
                session:
                  processorSession
              }
            } =
              await supabase.auth.getSession();

            if (
              processorSession?.expires_at &&
              processorSession.expires_at *
                1000 <
                Date.now() +
                  60 * 1000
            ) {
              const {
                data: refreshed
              } =
                await supabase.auth.refreshSession();

              processorSession =
                refreshed?.session ??
                processorSession;
            }

            const accessToken =
              processorSession?.access_token;

            if (!accessToken) {
              throw new Error(
                'No authenticated session available for video processing'
              );
            }

            const processingResponse =
              await fetch(
                `${SERVER_URL}/api/video-processing/process`,
                {
                  method: 'POST',
                  headers: {
                    'Content-Type':
                      'application/json',
                    Authorization:
                      `Bearer ${accessToken}`,
                  },
                  body:
                    JSON.stringify({
                      videoId:
                        insertedVideo.id
                    }),
                }
              );

            if (
              !processingResponse.ok
            ) {
              throw new Error(
                `Video processing trigger failed with HTTP ${processingResponse.status}`
              );
            }
          } catch (
            processingTriggerError
          ) {
            __DEV__ &&
              console.warn(
                '[UPLOAD] Immediate video processing trigger failed; sweeper will retry:',
                processingTriggerError?.message
              );
          }
        } else if (
          !SERVER_URL
        ) {
          __DEV__ &&
            console.warn(
              '[UPLOAD] EXPO_PUBLIC_SERVER_URL is missing; video processing sweeper will retry.'
            );
        }

        // Cleanup local thumbnail temp file — this must never be allowed to
        // throw here, since the DB insert has already succeeded at this
        // point. If deleteAsync threw uncaught, control would fall into the
        // catch block below and incorrectly delete the just-committed video
        // and thumbnail storage objects, leaving an orphaned DB row.
        if (finalThumbnailUri) {
          await deleteAsync(
            finalThumbnailUri,
            { idempotent: true }
          ).catch(() => {});
        }

        // Cleanup the app-owned temporary video copy now that it is committed.
        if (tempVideoUri) {
          await deleteAsync(
            tempVideoUri,
            { idempotent: true }
          ).catch(() => {});

          tempVideoUri = null;
          tempVideoUriRef.current =
            null;
        }

        if (!isMountedRef.current) {
          return;
        }

        setUploading(false);
        setProgressPercent(0);
        setProgressLabel('');
        setVideo(null);
        setThumbnailUri(null);
        setCaption('');
        setCategory('');

        if (autoApproved) {
          setDialog({
            visible: true,
            title:
              'Video Uploaded! 🎉',
            message:
              'Your video is being prepared for playback. It will appear on Bushrann once processing is complete.',
            type: 'success',
            buttons: [
              { text: 'OK' }
            ]
          });
        } else {
          setDialog({
            visible: true,
            title:
              'Video Uploaded! ⏳',
            message:
              'Your video is being prepared and is pending review. You will be notified once it is approved.',
            type: 'info',
            buttons: [
              { text: 'OK' }
            ]
          });
        }

      } catch (error) {
        // Best-effort close of the native FileHandle if tus-js-client has not
        // already closed it (e.g. an error before or outside onError).
        if (currentUploadSource) {
          currentUploadSource.close();

          if (
            activeVideoSourceRef.current ===
            currentUploadSource
          ) {
            activeVideoSourceRef.current =
              null;
          }

          currentUploadSource =
            null;
        }

        // Best-effort cleanup of anything already uploaded, so a failed
        // insert doesn't leave orphaned storage objects.
        if (uploadedVideoPath) {
          supabase.storage
            .from('videos')
            .remove([
              uploadedVideoPath
            ])
            .catch(() => {});
        }

        if (uploadedThumbPath) {
          supabase.storage
            .from('thumbnails')
            .remove([
              uploadedThumbPath
            ])
            .catch(() => {});
        }

        // Best-effort cleanup of the local thumbnail temp file so a failed
        // upload doesn't leave it stranded on device.
        if (finalThumbnailUri) {
          deleteAsync(
            finalThumbnailUri,
            { idempotent: true }
          ).catch(() => {});
        }

        // Best-effort cleanup of the app-owned temporary video copy on failure.
        if (tempVideoUri) {
          deleteAsync(
            tempVideoUri,
            { idempotent: true }
          ).catch(() => {});

          tempVideoUri = null;
          tempVideoUriRef.current =
            null;
        }

        // Diagnostic capture: report the real error with stage metadata so the
        // next reproduction reveals which step failed. Keep user-facing dialog
        // unchanged and do not log secrets/full URIs.
        try {
          const uriScheme =
            video?.uri?.split(':')[0] ||
            'unknown';

          const safeError =
            error instanceof Error
              ? error
              : new Error(
                  String(error)
                );

          Sentry.withScope(
            (scope) => {
              scope.setTag(
                'upload_stage',
                uploadStage
              );

              scope.setContext(
                'upload_diagnostics',
                {
                  uriScheme,
                  mimeType:
                    video?.mimeType ||
                    null,
                  fileSize:
                    video?.fileSize ||
                    null,
                  platform:
                    Platform.OS,
                  tusStatus:
                    error?._tusStatus ??
                    error?.status ??
                    error?.response
                      ?.status ??
                    null,
                }
              );

              Sentry.captureException(
                safeError
              );
            }
          );
        } catch (
          sentryError
        ) {}

        __DEV__ &&
          console.error(
            'Upload error:',
            error
          );

        if (
          !isMountedRef.current
        ) {
          return;
        }

        setUploading(false);
        setProgressPercent(0);
        setProgressLabel('');

        setDialog({
          visible: true,
          title: 'Upload failed',
          message: 'Something went wrong while uploading your video. Please try again.',
          type: 'error',
          buttons: [{ text: 'OK' }]
        });
      }
    } finally {
      isUploadingRef.current = false;
    }
  }, [
    video,
    caption,
    category,
    thumbnailUri,
    authUser,
    isBanned,
    scholarChecked
  ]);

  const handleGoLive =
    useCallback(() => {
      setShowLiveSetup(true);
    }, []);

  const startLiveStream =
    useCallback(() => {
      if (!isScholar) {
        setDialog({
          visible: true,
          title: 'Not Authorized',
          message: 'Only verified scholars can start a live stream.',
          type: 'error',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      if (!liveTitle.trim()) {
        setDialog({
          visible: true,
          title: 'Title required',
          message: 'Please enter a title for your live stream.',
          type: 'warning',
          buttons: [{ text: 'OK' }]
        });
        return;
      }

      const max =
        parseInt(maxQuestions) || 5;

      setShowLiveSetup(false);
      setLiveTitle('');
      setMaxQuestions('5');

      navigation.navigate(
        ROUTES.LIVE_STREAM,
        {
          title:
            liveTitle.trim(),
          maxQuestions: max
        }
      );
    }, [
      liveTitle,
      maxQuestions,
      navigation,
      isScholar
    ]);

  if (showLiveSetup) {
    return (
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop:
              insets.top + 24,
            paddingBottom:
              insets.bottom + 70
          }
        ]}
      >
        <Text style={styles.title}>
          🔴 Go Live
        </Text>

        <Text style={styles.subtitle}>
          Set up your live stream
        </Text>

        <Text style={styles.label}>
          Stream Title *
        </Text>

        <TextInput
          style={styles.input}
          placeholder="e.g. Friday Tafsir Lesson"
          placeholderTextColor="#aaaaaa"
          value={liveTitle}
          onChangeText={setLiveTitle}
          maxLength={60}
        />

        <Text style={styles.label}>
          Max Questions to Answer
        </Text>

        <Text style={styles.hint}>
          Viewers can submit questions. How many will you answer?
        </Text>

        <View
          style={
            styles.maxQuestionsRow
          }
        >
          {[
            '3',
            '5',
            '10',
            '15',
            '20'
          ].map(n => (
            <AnimatedButton
              key={n}
              style={[
                styles.qChip,
                maxQuestions === n &&
                  styles.qChipActive
              ]}
              onPress={() =>
                setMaxQuestions(n)
              }
            >
              <Text
                style={[
                  styles.qChipText,
                  maxQuestions === n &&
                    styles.qChipTextActive
                ]}
              >
                {n}
              </Text>
            </AnimatedButton>
          ))}
        </View>

        <AnimatedButton
          style={
            styles.goLiveConfirmBtn
          }
          onPress={
            startLiveStream
          }
        >
          <Text
            style={
              styles.goLiveConfirmBtnText
            }
          >
            🔴 Start Live Stream
          </Text>
        </AnimatedButton>

        <AnimatedButton
          style={styles.cancelBtn}
          onPress={() =>
            setShowLiveSetup(false)
          }
        >
          <Text
            style={
              styles.cancelBtnText
            }
          >
            Cancel
          </Text>
        </AnimatedButton>

        <ModernDialog
          visible={
            dialog.visible
          }
          title={dialog.title}
          message={dialog.message}
          type={dialog.type}
          buttons={dialog.buttons}
          onDismiss={() =>
            setDialog({
              ...dialog,
              visible: false
            })
          }
        />
      </ScrollView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={
        Platform.OS === 'ios'
          ? 'padding'
          : 'height'
      }
    >
      <ScrollView
        ref={scrollRef}
        style={styles.container}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop:
              insets.top + 24,
            paddingBottom:
              insets.bottom + 70
          }
        ]}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.title}>
          Upload Video
        </Text>

        <Text style={styles.subtitle}>
          Share your dawah with the ummah ☪️
        </Text>

        {isScholar === true && (
          <AnimatedButton
            style={styles.liveBtn}
            onPress={
              handleGoLive
            }
          >
            <Text
              style={
                styles.liveDot
              }
            >
              🔴
            </Text>

            <Text
              style={
                styles.liveBtnText
              }
            >
              Go Live
            </Text>

            <View
              style={
                styles.scholarBadge
              }
            >
              <Text
                style={
                  styles.scholarBadgeText
                }
              >
                Scholar
              </Text>
            </View>
          </AnimatedButton>
        )}

        <AnimatedButton
          style={
            styles.videoPicker
          }
          onPress={pickVideo}
          disabled={
            uploading ||
            generatingThumb
          }
        >
          {generatingThumb ? (
            <View
              style={
                styles.videoSelected
              }
            >
              <Text
                style={
                  styles.videoSelectedIcon
                }
              >
                ⏳
              </Text>

              <Text
                style={
                  styles.videoSelectedText
                }
              >
                Generating thumbnail...
              </Text>
            </View>
          ) : thumbnailUri ? (
            <View
              style={
                styles.thumbnailPreviewContainer
              }
            >
              <Image
                source={{
                  uri: thumbnailUri
                }}
                style={
                  styles.thumbnailPreview
                }
                resizeMode="cover"
              />

              <View
                style={
                  styles.thumbnailOverlay
                }
              >
                <Text
                  style={
                    styles.thumbnailText
                  }
                >
                  🎬 Thumbnail Preview
                </Text>

                <Text
                  style={
                    styles.tapToChange
                  }
                >
                  Tap to change video
                </Text>
              </View>
            </View>
          ) : video ? (
            <View
              style={
                styles.videoSelected
              }
            >
              <Text
                style={
                  styles.videoSelectedIcon
                }
              >
                🎬
              </Text>

              <Text
                style={
                  styles.videoSelectedText
                }
              >
                Video selected!
              </Text>

              <Text
                style={
                  styles.videoSelectedName
                }
                numberOfLines={1}
              >
                {video.uri
                  .split('/')
                  .pop()}
              </Text>

              <Text
                style={
                  styles.tapToChange
                }
              >
                Tap to change
              </Text>
            </View>
          ) : (
            <View
              style={
                styles.videoPlaceholder
              }
            >
              <Text
                style={
                  styles.videoPlaceholderIcon
                }
              >
                📹
              </Text>

              <Text
                style={
                  styles.videoPlaceholderText
                }
              >
                Tap to select a video
              </Text>

              <Text
                style={
                  styles.videoPlaceholderSub
                }
              >
                from your camera roll
              </Text>
            </View>
          )}
        </AnimatedButton>

        <Text style={styles.label}>
          Caption
        </Text>

        <View
          style={
            styles.inputWrapper
          }
        >
          <TextInput
            style={styles.input}
            placeholder="What is this video about?"
            placeholderTextColor="#aaaaaa"
            value={caption}
            onChangeText={
              setCaption
            }
            multiline
            maxLength={200}
            editable={!uploading}
          />

          <Text
            style={
              styles.charCount
            }
          >
            {caption.length}/200
          </Text>
        </View>

        <Text style={styles.label}>
          Category
        </Text>

        <View
          style={
            styles.categories
          }
        >
          {CATEGORIES.map(
            cat => (
              <AnimatedButton
                key={cat}
                style={[
                  styles.categoryChip,
                  category === cat &&
                    styles.categoryChipActive
                ]}
                onPress={() =>
                  !uploading &&
                  setCategory(cat)
                }
              >
                <Text
                  style={[
                    styles.categoryChipText,
                    category === cat &&
                      styles.categoryChipTextActive
                  ]}
                >
                  {cat}
                </Text>
              </AnimatedButton>
            )
          )}
        </View>

        <AnimatedButton
          style={[
            styles.uploadBtn,
            (
              uploading ||
              generatingThumb
            ) &&
              styles.uploadBtnDisabled
          ]}
          onPress={uploadVideo}
          disabled={
            uploading ||
            generatingThumb
          }
        >
          {uploading && (
            <View
              style={
                styles.tiktokBarBg
              }
            >
              <View
                style={[
                  styles.tiktokBarFill,
                  {
                    width:
                      `${progressPercent}%`
                  }
                ]}
              />
            </View>
          )}

          <View
            style={
              styles.uploadBtnContent
            }
          >
            <Text
              style={
                styles.uploadBtnText
              }
            >
              {uploading
                ? progressLabel
                : generatingThumb
                  ? 'Generating thumbnail...'
                  : 'Upload to Bushrann ☪️'}
            </Text>

            {uploading && (
              <Text
                style={
                  styles.uploadBtnPct
                }
              >
                {progressPercent}%
              </Text>
            )}
          </View>
        </AnimatedButton>

        {scholarChecked &&
          isScholar === false && (
            <View
              style={
                styles.scholarInfo
              }
            >
              <Text
                style={
                  styles.scholarInfoIcon
                }
              >
                🎓
              </Text>

              <Text
                style={
                  styles.scholarInfoText
                }
              >
                Are you a verified Islamic scholar? Contact us to get your Scholar badge and unlock live streaming.
              </Text>
            </View>
          )}

        <ModernDialog
          visible={
            dialog.visible
          }
          title={dialog.title}
          message={
            dialog.message
          }
          type={dialog.type}
          buttons={
            dialog.buttons
          }
          onDismiss={() =>
            setDialog({
              ...dialog,
              visible: false
            })
          }
        />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles =
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor:
        '#ffffff'
    },

    content: {
      padding: 24
    },

    title: {
      fontSize: 28,
      fontWeight: '800',
      color: '#1a2e44',
      marginBottom: 4,
      letterSpacing: -0.5
    },

    subtitle: {
      fontSize: 14,
      color: '#aaaaaa',
      marginBottom: 28
    },

    hint: {
      color: '#aaaaaa',
      fontSize: 12,
      marginBottom: 10
    },

    liveBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor:
        '#fff5f5',
      borderWidth: 1,
      borderColor:
        COLORS.live,
      borderRadius: 16,
      padding: 16,
      marginBottom: 20,
      gap: 10,
      shadowColor:
        COLORS.live,
      shadowOpacity: 0.15,
      shadowRadius: 8,
      shadowOffset: {
        width: 0,
        height: 3
      },
      elevation: 3
    },

    liveDot: {
      fontSize: 18
    },

    liveBtnText: {
      color: COLORS.live,
      fontSize: 16,
      fontWeight: '700',
      flex: 1
    },

    scholarBadge: {
      backgroundColor:
        COLORS.live,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 3
    },

    scholarBadgeText: {
      color: '#fff',
      fontSize: 12,
      fontWeight: '700'
    },

    videoPicker: {
      backgroundColor:
        '#fafafa',
      borderRadius: 18,
      borderWidth: 2,
      borderColor:
        COLORS.gold + '40',
      borderStyle: 'dashed',
      marginBottom: 24,
      overflow: 'hidden'
    },

    videoPlaceholder: {
      padding: 44,
      alignItems: 'center'
    },

    videoPlaceholderIcon: {
      fontSize: 56,
      marginBottom: 14
    },

    videoPlaceholderText: {
      color: '#1a2e44',
      fontSize: 16,
      fontWeight: '700',
      marginBottom: 4
    },

    videoPlaceholderSub: {
      color: '#aaaaaa',
      fontSize: 13
    },

    videoSelected: {
      padding: 24,
      alignItems: 'center'
    },

    videoSelectedIcon: {
      fontSize: 44,
      marginBottom: 10
    },

    videoSelectedText: {
      color:
        COLORS.success,
      fontSize: 16,
      fontWeight: '700',
      marginBottom: 4
    },

    videoSelectedSubtext: {
      color: '#888888',
      fontSize: 12,
      textAlign: 'center',
      marginTop: 4
    },

    videoSelectedName: {
      color: '#aaaaaa',
      fontSize: 12,
      marginBottom: 8
    },

    tapToChange: {
      color: '#bbbbbb',
      fontSize: 12
    },

    thumbnailPreviewContainer: {
      width: '100%',
      height: 200,
      position: 'relative',
      backgroundColor:
        '#000'
    },

    thumbnailPreview: {
      width: '100%',
      height: '100%'
    },

    thumbnailOverlay: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      backgroundColor:
        'rgba(0,0,0,0.6)',
      padding: 12,
      alignItems: 'center'
    },

    thumbnailText: {
      color: '#fff',
      fontSize: 14,
      fontWeight: '600'
    },

    label: {
      color: '#666666',
      fontSize: 12,
      fontWeight: '700',
      textTransform:
        'uppercase',
      letterSpacing: 1,
      marginBottom: 10
    },

    input: {
      backgroundColor:
        '#f8f8f8',
      borderWidth: 1,
      borderColor:
        '#eeeeee',
      borderRadius: 14,
      padding: 16,
      color: '#1a2e44',
      fontSize: 15,
      minHeight: 80,
      textAlignVertical:
        'top'
    },

    inputWrapper: {
      marginBottom: 20
    },

    charCount: {
      color: '#bbbbbb',
      fontSize: 12,
      textAlign: 'right',
      marginTop: 4
    },

    categories: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 32
    },

    categoryChip: {
      backgroundColor:
        '#f5f5f5',
      borderWidth: 1,
      borderColor:
        '#eeeeee',
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 8
    },

    categoryChipActive: {
      backgroundColor:
        COLORS.gold,
      borderColor:
        COLORS.gold
    },

    categoryChipText: {
      color: '#888888',
      fontSize: 13,
      fontWeight: '600'
    },

    categoryChipTextActive: {
      color: '#ffffff',
      fontWeight: '700'
    },

    uploadBtn: {
      backgroundColor:
        COLORS.gold,
      borderRadius: 16,
      paddingVertical: 18,
      paddingHorizontal: 24,
      marginBottom: 20,
      overflow: 'hidden',
      shadowColor:
        COLORS.gold,
      shadowOpacity: 0.4,
      shadowRadius: 12,
      shadowOffset: {
        width: 0,
        height: 4
      },
      elevation: 6,
      alignItems: 'center'
    },

    uploadBtnDisabled: {
      backgroundColor:
        COLORS.goldDark
    },

    uploadBtnContent: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent:
        'center',
      gap: 8
    },

    uploadBtnText: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '700',
      textAlign: 'center'
    },

    uploadBtnPct: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '800'
    },

    tiktokBarBg: {
      position: 'absolute',
      bottom: -15,
      left: -30,
      right: -30,
      height: 4,
      backgroundColor:
        'rgba(255,255,255,0.3)'
    },

    tiktokBarFill: {
      height: 4,
      backgroundColor:
        '#ffffff'
    },

    scholarInfo: {
      flexDirection: 'row',
      backgroundColor:
        '#fff8ec',
      borderRadius: 14,
      padding: 14,
      gap: 10,
      marginBottom: 40,
      alignItems:
        'flex-start',
      borderWidth: 1,
      borderColor:
        COLORS.gold + '30'
    },

    scholarInfoIcon: {
      fontSize: 20
    },

    scholarInfoText: {
      color: '#888888',
      fontSize: 13,
      lineHeight: 20,
      flex: 1
    },

    maxQuestionsRow: {
      flexDirection: 'row',
      gap: 10,
      marginBottom: 28,
      flexWrap: 'wrap'
    },

    qChip: {
      backgroundColor:
        '#f5f5f5',
      borderWidth: 1,
      borderColor:
        '#eeeeee',
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 10
    },

    qChipActive: {
      backgroundColor:
        COLORS.gold,
      borderColor:
        COLORS.gold
    },

    qChipText: {
      color: '#888888',
      fontSize: 15,
      fontWeight: '600'
    },

    qChipTextActive: {
      color: '#ffffff',
      fontWeight: '700'
    },

    goLiveConfirmBtn: {
      backgroundColor:
        COLORS.live,
      borderRadius: 16,
      padding: 18,
      alignItems: 'center',
      marginBottom: 12,
      shadowColor:
        COLORS.live,
      shadowOpacity: 0.3,
      shadowRadius: 8,
      shadowOffset: {
        width: 0,
        height: 3
      },
      elevation: 4
    },

    goLiveConfirmBtnText: {
      color: '#ffffff',
      fontSize: 16,
      fontWeight: '700'
    },

    cancelBtn: {
      borderWidth: 2,
      borderColor:
        '#1a2e44',
      borderRadius: 16,
      padding: 16,
      alignItems: 'center',
      marginBottom: 40,
      backgroundColor:
        '#ffffff'
    },

    cancelBtnText: {
      color: '#1a2e44',
      fontSize: 16,
      fontWeight: '600'
    }
  });