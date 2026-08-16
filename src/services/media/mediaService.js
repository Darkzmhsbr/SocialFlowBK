// Business logic for media uploads. Sits between the controller (which
// only cares about HTTP) and Cloudinary + Prisma. Every rule that decides
// "is this file allowed?" lives here.

const cloudinaryClient = require('../../integrations/cloudinary/cloudinaryClient');
const mediaRepository = require('../../database/mediaRepository');
const env = require('../../config/env');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const IMAGE_MIMES = new Set(env.uploads.allowedImageMimes);
const VIDEO_MIMES = new Set(env.uploads.allowedVideoMimes);

/**
 * Handle a fresh upload: validate, push to Cloudinary, save the row.
 *
 * @param {object} args
 * @param {string} args.userId
 * @param {{ buffer: Buffer, mimetype: string, size: number, originalname: string }} args.file - req.file from multer
 * @returns {Promise<MediaAsset>}
 */
async function uploadFile({ userId, file }) {
  if (!file || !file.buffer) {
    throw new AppError(ErrorCodes.NO_FILE_UPLOADED, 'Nenhum arquivo enviado.', 400);
  }

  const { type, resourceType } = classifyMime(file.mimetype);
  enforceSizeLimit(type, file.size);

  logger.info('Media upload starting', {
    userId,
    filename: file.originalname,
    mimetype: file.mimetype,
    bytes: file.size,
    type,
  });

  const uploaded = await cloudinaryClient.uploadBuffer(file.buffer, {
    userId,
    resourceType,
    filename: file.originalname,
  });

  const asset = await mediaRepository.create({
    userId,
    type,
    cloudinaryPublicId: uploaded.publicId,
    url: uploaded.url,
    format: uploaded.format,
    bytes: uploaded.bytes,
    width: uploaded.width || null,
    height: uploaded.height || null,
    durationSec: uploaded.durationSec || null,
  });

  logger.info('Media upload saved', {
    userId,
    mediaId: asset.id,
    cloudinaryPublicId: asset.cloudinaryPublicId,
    type: asset.type,
  });

  return asset;
}

function classifyMime(mimetype) {
  if (IMAGE_MIMES.has(mimetype)) return { type: 'IMAGE', resourceType: 'image' };
  if (VIDEO_MIMES.has(mimetype)) return { type: 'VIDEO', resourceType: 'video' };
  throw new AppError(
    ErrorCodes.INVALID_MEDIA_TYPE,
    `Tipo de arquivo não suportado (${mimetype}).`,
    400
  );
}

function enforceSizeLimit(type, sizeBytes) {
  const limit = type === 'IMAGE' ? env.uploads.maxImageBytes : env.uploads.maxVideoBytes;
  if (sizeBytes > limit) {
    const limitMb = Math.floor(limit / (1024 * 1024));
    throw new AppError(
      ErrorCodes.MEDIA_TOO_LARGE,
      `Arquivo maior que o limite permitido (${limitMb} MB para ${type === 'IMAGE' ? 'imagens' : 'vídeos'}).`,
      413
    );
  }
}

function listByUser(userId, pagination) {
  return mediaRepository.findAllByUserId(userId, pagination);
}

async function getById(id, userId) {
  const asset = await mediaRepository.findById(id);
  if (!asset || asset.userId !== userId) {
    throw new AppError(ErrorCodes.MEDIA_NOT_FOUND, 'Mídia não encontrada.', 404);
  }
  return asset;
}

async function deleteById(id, userId) {
  const asset = await getById(id, userId);
  const resourceType = asset.type === 'VIDEO' ? 'video' : 'image';

  // Try Cloudinary first, but don't fail the whole operation if it errors -
  // the file may already have been removed, or the account key rotated.
  // The DB row is the source of truth for the user; orphans get cleaned up
  // out-of-band if needed.
  await cloudinaryClient.deleteAsset(asset.cloudinaryPublicId, resourceType);
  await mediaRepository.deleteById(id);
  return { id };
}

// Strips storage-specific internals before returning to the frontend. The
// public shape is stable even if we change providers later.
function toPublicShape(asset) {
  return {
    id: asset.id,
    type: asset.type,
    url: asset.url,
    format: asset.format,
    bytes: asset.bytes,
    width: asset.width,
    height: asset.height,
    durationSec: asset.durationSec,
    createdAt: asset.createdAt,
  };
}

module.exports = { uploadFile, listByUser, getById, deleteById, toPublicShape };