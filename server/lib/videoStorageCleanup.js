// Shared storage cleanup for videos rows.
//
// Strictly parses the public Supabase Storage URLs on a videos row and
// deletes the exact S3 objects they reference. A non-null URL that cannot
// be safely parsed, or any S3 deletion error, marks the cleanup as not ok
// so the caller can keep the DB row (retry-safe).

const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const ALLOWED_BUCKETS = new Set(['videos', 'thumbnails']);

// ─────────────────────────────────────────────────────────────
// S3 (same pattern as routes/videoProcessing.js)
// ─────────────────────────────────────────────────────────────

function getS3Client() {
  const required = [
    'SUPABASE_S3_KEY_ID',
    'SUPABASE_S3_SECRET',
    'SUPABASE_S3_ENDPOINT',
  ];

  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing Supabase S3 configuration: ${missing.join(', ')}`
    );
  }

  return new S3Client({
    region: process.env.SUPABASE_S3_REGION || 'us-east-1',

    endpoint: process.env.SUPABASE_S3_ENDPOINT,

    credentials: {
      accessKeyId: process.env.SUPABASE_S3_KEY_ID,
      secretAccessKey: process.env.SUPABASE_S3_SECRET,
    },

    forcePathStyle: true,
  });
}

// ─────────────────────────────────────────────────────────────
// STORAGE URL PARSING
// ─────────────────────────────────────────────────────────────

// Strictly parse a public Supabase Storage URL into { bucket, key }.
// Mirrors encodeStorageKey/getPublicVideoUrl in routes/videoProcessing.js:
// URLs are `${SUPABASE_URL}/storage/v1/object/public/{bucket}/{urlencoded-key}`
// Returns null on any mismatch. NEVER delete anything that fails this parse.
function parseStorageUrl(url) {
  if (typeof url !== 'string' || !url) return null;

  const prefix = `${process.env.SUPABASE_URL}/storage/v1/object/public/`;

  if (!url.startsWith(prefix)) return null;

  const remainder = url.slice(prefix.length);

  const slashIndex = remainder.indexOf('/');
  if (slashIndex <= 0) return null;

  const bucket = remainder.slice(0, slashIndex);
  const encodedKey = remainder.slice(slashIndex + 1);

  if (!ALLOWED_BUCKETS.has(bucket)) return null;
  if (!encodedKey || encodedKey.startsWith('/')) return null;

  // Decode per segment (mirror of encodeStorageKey).
  let key;
  try {
    key = encodedKey
      .split('/')
      .map(part => decodeURIComponent(part))
      .join('/');
  } catch (error) {
    return null;
  }

  if (!key || key.startsWith('/') || key.split('/').some(part => part === '..')) {
    return null;
  }

  return { bucket, key };
}

// ─────────────────────────────────────────────────────────────
// CLEANUP
// ─────────────────────────────────────────────────────────────

// Deletes the storage objects referenced by a videos row.
// Returns { ok, objectsCleaned, storageFailed, unparseableUrls } where
// ok === (unparseableUrls === 0 && storageFailed.length === 0).
async function cleanupVideoStorage(videoRow) {
  const videoId = videoRow?.id;

  // Build the exact object list. Dedupe by `bucket:key`.
  // EXTENSION POINT: a future watermarked object
  // ({ bucket: 'videos', key: `watermarked/v1/${videoId}.mp4` }) can be
  // appended to candidateUrls here.
  const candidateUrls = [
    videoRow.original_video_url,
    videoRow.video_url,
    videoRow.thumbnail_url,
  ];

  const objects = new Map(); // `${bucket}:${key}` -> { bucket, key }
  // A non-null URL we cannot safely parse means we cannot guarantee cleanup
  // of that object — treat it as a cleanup failure and keep the DB row.
  let unparseableUrls = 0;

  for (const url of candidateUrls) {
    if (!url) continue;

    const parsed = parseStorageUrl(url);

    if (!parsed) {
      console.warn('[VIDEOS] Could not parse storage URL for video:', videoId);
      unparseableUrls += 1;
      continue;
    }

    objects.set(`${parsed.bucket}:${parsed.key}`, parsed);
  }

  // Delete each storage object. Failures are warn-only and collected.
  const storageFailed = [];

  let s3 = null;
  if (objects.size > 0) {
    try {
      s3 = getS3Client();
    } catch (error) {
      console.warn('[VIDEOS] S3 client unavailable for video:', videoId, error.message);
      for (const { bucket, key } of objects.values()) {
        storageFailed.push(`${bucket}:${key}`);
      }
    }
  }

  if (s3) {
    for (const { bucket, key } of objects.values()) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
          })
        );
      } catch (error) {
        // Deleting a missing key succeeds on S3; any real error is warn-only.
        console.warn(
          '[VIDEOS] Failed to delete storage object for video:',
          videoId,
          error.message
        );
        storageFailed.push(`${bucket}:${key}`);
      }
    }
  }

  const ok = unparseableUrls === 0 && storageFailed.length === 0;

  if (!ok) {
    console.warn(
      '[VIDEOS] Storage cleanup incomplete for video:',
      videoId,
      'unparseable URLs:',
      unparseableUrls,
      'failed objects:',
      storageFailed.length
    );
  }

  return {
    ok,
    objectsCleaned: objects.size - storageFailed.length,
    storageFailed,
    unparseableUrls,
  };
}

module.exports = {
  cleanupVideoStorage,
  parseStorageUrl,
  ALLOWED_BUCKETS,
};
