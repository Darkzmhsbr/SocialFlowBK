// This is the ONLY file in the project that knows about Cloudinary. Every
// service that needs to upload/delete a file goes through here. If we ever
// migrate away from Cloudinary (to R2, Backblaze, S3), this is the single
// file that changes - services above stay untouched.
//
// The upload flow:
//   1. Multer parses the multipart request in memory -> Buffer
//   2. mediaService calls uploadBuffer(buffer, { userId, resourceType })
//   3. This module streams the buffer to Cloudinary via upload_stream
//   4. Returns a normalized shape (url, publicId, format, bytes, dimensions)

const { v2: cloudinary } = require('cloudinary');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

// Configure once at module load. cloudinary.config() is idempotent so this
// is safe even if the module gets required from multiple entry points.
cloudinary.config({
  cloud_name: env.cloudinary.cloudName,
  api_key: env.cloudinary.apiKey,
  api_secret: env.cloudinary.apiSecret,
  secure: true, // always deliver via HTTPS (Meta rejects plain HTTP)
});

/**
 * Upload a file buffer to Cloudinary.
 *
 * @param {Buffer} buffer         - the file bytes from multer
 * @param {object} opts
 * @param {string} opts.userId    - used to scope the storage folder per user
 * @param {'image'|'video'} opts.resourceType
 * @param {string} [opts.filename] - original filename, only used for logging
 * @returns {Promise<{ publicId: string, url: string, format: string,
 *                     bytes: number, width?: number, height?: number,
 *                     durationSec?: number }>}
 */
function uploadBuffer(buffer, { userId, resourceType, filename }) {
  return new Promise((resolve, reject) => {
    const folder = `${env.cloudinary.rootFolder}/${userId}`;

    const uploadStream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: resourceType, // 'image' or 'video'
        // Let Cloudinary generate a random suffix to avoid collisions.
        use_filename: false,
        unique_filename: true,
        // Videos take longer to process; give plenty of headroom.
        timeout: resourceType === 'video' ? 120000 : 30000,
      },
      (error, result) => {
        if (error) {
          logger.error('Cloudinary upload failed', {
            userId,
            filename,
            resourceType,
            message: error.message,
            httpCode: error.http_code,
          });
          return reject(
            new AppError(
              ErrorCodes.UPLOAD_FAILED,
              'Não foi possível enviar o arquivo. Tente novamente.',
              502,
              { cloudinary: error.message }
            )
          );
        }

        resolve({
          publicId: result.public_id,
          url: result.secure_url,
          format: result.format,
          bytes: result.bytes,
          width: result.width,
          height: result.height,
          durationSec: result.duration, // only present for videos
        });
      }
    );

    uploadStream.end(buffer);
  });
}

/**
 * Delete an asset from Cloudinary. Called when a MediaAsset is deleted
 * from the database so we don't accumulate orphan files in the account.
 *
 * @param {string} publicId
 * @param {'image'|'video'} resourceType
 */
async function deleteAsset(publicId, resourceType = 'image') {
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType,
      invalidate: true,
    });
    return result;
  } catch (error) {
    // Don't throw - deletion failures shouldn't block the DB delete. Just log.
    logger.warn('Cloudinary delete failed (asset may become orphan)', {
      publicId,
      resourceType,
      message: error.message,
    });
    return null;
  }
}

module.exports = { uploadBuffer, deleteAsset };