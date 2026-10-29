// This is the ONLY file in the project that knows about Backblaze B2. Every
// service that needs to upload/delete a file goes through here. If we ever
// migrate to another provider (R2, S3 proper, GCS), this is the single
// file that changes — services above stay untouched.
//
// Backblaze B2 exposes an S3-compatible endpoint, so we use the official
// AWS SDK v3. Key differences vs the AWS S3 client:
//   - forcePathStyle: true is REQUIRED. B2 doesn't route virtual-hosted
//     style requests correctly (bucket-as-subdomain).
//   - Region name is B2-specific (e.g. "us-east-005"), not the AWS names.
//   - Public URLs use the "friendly URL" host f<NNN>.backblazeb2.com, not
//     the S3 endpoint — cheaper CDN edge, shorter to type. Built from
//     env.backblaze.publicBaseUrl.
//
// The upload flow mirrors cloudinaryClient exactly so mediaService can
// call either one with the same shape:
//   1. Multer parses the multipart request in memory -> Buffer
//   2. mediaService calls uploadBuffer(buffer, { userId, resourceType })
//   3. This module PUTs the buffer to B2 with a random object key
//   4. Returns { storageKey, url, format, bytes, width?, height?, durationSec? }
//
// Notes on the returned shape:
//   - width/height/durationSec are NOT filled here — Backblaze doesn't
//     inspect media. mediaService gets zeros/undefined and the frontend
//     is fine because Instagram itself doesn't require them, and the
//     preview uses natural rendering. If we want them, add a probe step
//     (sharp for images, ffprobe for videos) BEFORE this upload — that's
//     a separate concern from storage.
//
// Rodada 4: copyToTempKey() makes a server-side copy of an existing object
// under a temporary key (no download, no re-upload). The publish service
// uses it so each Instagram account fetches the media from a different URL;
// the copy is removed with deleteAsset() right after publishing.

const {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand, // Rodada 4: server-side copy for per-account temp URLs
} = require('@aws-sdk/client-s3');
const crypto = require('crypto');
const path = require('path');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Single client instance reused across requests. Configured at module load.
const s3 = new S3Client({
  endpoint: env.backblaze.endpoint,
  region: env.backblaze.region,
  credentials: {
    accessKeyId: env.backblaze.keyId,
    secretAccessKey: env.backblaze.applicationKey,
  },
  // MANDATORY for Backblaze — see file header.
  forcePathStyle: true,
});

// Maps our uploaded MIME types to file extensions we save in the object
// key. Keeping the extension makes the friendly URL human-readable and
// helps Instagram infer the type from the URL if it ever falls back to
// extension-sniffing.
const MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
};

/**
 * Upload a file buffer to Backblaze B2.
 *
 * @param {Buffer} buffer         - the file bytes from multer
 * @param {object} opts
 * @param {string} opts.userId    - used to scope the storage folder per user
 * @param {'image'|'video'} opts.resourceType
 * @param {string} opts.mimetype  - REQUIRED — passed to B2 as Content-Type
 *                                  so the browser/Instagram receives the
 *                                  right header on GET
 * @param {string} [opts.filename] - original filename, only used for logging
 * @returns {Promise<{ storageKey: string, url: string, format: string,
 *                     bytes: number, width?: number, height?: number,
 *                     durationSec?: number }>}
 */
async function uploadBuffer(buffer, { userId, resourceType, mimetype, filename }) {
  const ext = pickExtension(mimetype, filename);
  const key = buildObjectKey({ userId, ext });

  logger.info('Backblaze upload starting', {
    userId,
    filename,
    mimetype,
    resourceType,
    bytes: buffer.length,
    key,
  });

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: env.backblaze.bucketName,
        Key: key,
        Body: buffer,
        ContentType: mimetype,
        // Cache for a year on any downstream CDN (Meta or the browser).
        // The URL is stable — we never overwrite an existing key — so
        // long caching is safe.
        CacheControl: 'public, max-age=31536000, immutable',
      })
    );
  } catch (error) {
    logger.error('Backblaze upload failed', {
      userId,
      filename,
      key,
      message: error.message,
      code: error.Code || error.name,
      httpStatus: error.$metadata?.httpStatusCode,
    });
    throw new AppError(
      ErrorCodes.UPLOAD_FAILED,
      'Não foi possível enviar o arquivo. Tente novamente.',
      502,
      { backblaze: error.message }
    );
  }

  const url = buildPublicUrl(key);

  logger.info('Backblaze upload saved', { userId, key, url });

  return {
    storageKey: key,
    url,
    format: ext,
    bytes: buffer.length,
    // Backblaze doesn't inspect media dimensions/duration. Left undefined
    // so the caller can decide whether to probe (sharp/ffprobe) later.
    width: undefined,
    height: undefined,
    durationSec: undefined,
  };
}

/**
 * Delete an object from Backblaze. Called when a MediaAsset is deleted
 * from the database so we don't accumulate orphan files.
 *
 * With the bucket lifecycle set to "Keep only the last version", this
 * DeleteObject removes the file for good — no hidden versions accumulate.
 *
 * @param {string} storageKey - the object key stored on MediaAsset.storageKey
 * @param {'image'|'video'} [_resourceType] - unused for B2; kept in the
 *                                            signature to match cloudinaryClient
 */
async function deleteAsset(storageKey, _resourceType) {
  try {
    await s3.send(
      new DeleteObjectCommand({
        Bucket: env.backblaze.bucketName,
        Key: storageKey,
      })
    );
    return { deleted: true };
  } catch (error) {
    // Don't throw — deletion failures shouldn't block the DB delete. Just log.
    logger.warn('Backblaze delete failed (asset may become orphan)', {
      storageKey,
      message: error.message,
      code: error.Code || error.name,
    });
    return null;
  }
}

/**
 * Rodada 4: server-side copy of an existing object to a temporary key.
 *
 * The bytes never leave Backblaze (S3 CopyObject), so even a 100MB video
 * is copied quickly. Content-Type and Cache-Control are preserved
 * (MetadataDirective: COPY). The temp key lives under
 * {rootFolder}/{userId}/tmp/ and always carries a random uuid, so two
 * accounts publishing the same media at the same moment never collide.
 *
 * Throws AppError(UPLOAD_FAILED) on failure — the caller (publish service)
 * catches it and falls back to the original URL, so a failed copy never
 * blocks a publish.
 *
 * @param {string} sourceKey - storageKey of the original MediaAsset
 * @param {object} opts
 * @param {string} opts.userId
 * @param {string} [opts.tag] - short label added to the key (e.g. post id prefix)
 * @returns {Promise<{ storageKey: string, url: string }>}
 */
async function copyToTempKey(sourceKey, { userId, tag } = {}) {
  const ext = path.extname(sourceKey || '').slice(1).toLowerCase() || 'bin';
  const uuid = crypto.randomUUID().replace(/-/g, '');
  const safeTag = String(tag || 'tmp').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64) || 'tmp';
  const key = `${env.backblaze.rootFolder}/${userId}/tmp/${safeTag}-${uuid}.${ext}`;

  try {
    await s3.send(
      new CopyObjectCommand({
        Bucket: env.backblaze.bucketName,
        Key: key,
        // CopySource is "<bucket>/<key>", URL-encoded. encodeURI keeps the
        // "/" separators of our nested keys intact.
        CopySource: `${env.backblaze.bucketName}/${encodeURI(sourceKey)}`,
        MetadataDirective: 'COPY',
      })
    );
  } catch (error) {
    logger.warn('Backblaze temp copy failed', {
      sourceKey,
      key,
      message: error.message,
      code: error.Code || error.name,
      httpStatus: error.$metadata?.httpStatusCode,
    });
    throw new AppError(
      ErrorCodes.UPLOAD_FAILED,
      'Não foi possível preparar a cópia temporária da mídia.',
      502,
      { backblaze: error.message }
    );
  }

  return { storageKey: key, url: buildPublicUrl(key) };
}

// -----------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------

function pickExtension(mimetype, filename) {
  if (MIME_TO_EXT[mimetype]) return MIME_TO_EXT[mimetype];
  // Fallback: pull from filename if the mime is something odd. Keep it
  // lowercase and strip the dot. If truly missing, use 'bin' — Instagram
  // will still fetch based on Content-Type, but URL looks ugly.
  const ext = filename ? path.extname(filename).slice(1).toLowerCase() : '';
  return ext || 'bin';
}

function buildObjectKey({ userId, ext }) {
  // Random UUID without hyphens — 32 chars, URL-safe, effectively
  // collision-free. Nested under rootFolder/userId/ so files-per-user
  // stay grouped in the B2 web console.
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `${env.backblaze.rootFolder}/${userId}/${uuid}.${ext}`;
}

function buildPublicUrl(key) {
  // Format: https://f<NNN>.backblazeb2.com/file/<bucket>/<key>
  // (or the S3 endpoint form — publicBaseUrl controls which via env).
  return `${env.backblaze.publicBaseUrl}/file/${env.backblaze.bucketName}/${key}`;
}

module.exports = { uploadBuffer, deleteAsset };

// Rodada 4: appended so the original export line stays untouched.
module.exports.copyToTempKey = copyToTempKey;