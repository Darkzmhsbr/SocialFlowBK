// All Prisma queries for ScheduledPost + PostMedia live here. Includes the
// full media graph on every read so services never need to worry about
// missing joins.

const prisma = require('../config/database');

// Always attached to reads so callers get { medias: [{ order, mediaAsset }] }.
const POST_INCLUDE = {
  medias: {
    include: { mediaAsset: true },
    orderBy: { order: 'asc' },
  },
  instagramAccount: {
    select: {
      id: true,
      username: true,
      name: true,
      profilePictureUrl: true,
      accountType: true,
    },
  },
};

/**
 * @param {object} data
 * @param {string} data.userId
 * @param {string} data.instagramAccountId
 * @param {'FEED_IMAGE'|'FEED_VIDEO'|'FEED_CAROUSEL'|'REEL'|'STORY'} data.type
 * @param {string|null} data.caption
 * @param {'DRAFT'|'SCHEDULED'} data.status
 * @param {Date|null} data.scheduledFor
 * @param {Array<{ mediaAssetId: string, order: number }>} data.medias
 */
function create(data) {
  return prisma.scheduledPost.create({
    data: {
      userId: data.userId,
      instagramAccountId: data.instagramAccountId,
      type: data.type,
      caption: data.caption,
      status: data.status,
      scheduledFor: data.scheduledFor,
      medias: {
        create: data.medias.map((m) => ({
          order: m.order,
          mediaAsset: { connect: { id: m.mediaAssetId } },
        })),
      },
    },
    include: POST_INCLUDE,
  });
}

function findById(id) {
  return prisma.scheduledPost.findUnique({
    where: { id },
    include: POST_INCLUDE,
  });
}

function findAllByUserId(userId, { status, take = 50, skip = 0 } = {}) {
  return prisma.scheduledPost.findMany({
    where: {
      userId,
      ...(status ? { status } : {}),
    },
    orderBy: [
      // Scheduled first (soonest first), then by creation date desc for the rest.
      { scheduledFor: 'asc' },
      { createdAt: 'desc' },
    ],
    take,
    skip,
    include: POST_INCLUDE,
  });
}

/**
 * Updates fields the user may edit while a post is still editable. Media
 * replacement (if provided) wipes all existing PostMedia rows and recreates
 * them - safer than diffing when the whole set changes.
 */
function updateEditable(id, patch) {
  const { caption, scheduledFor, status, type, medias } = patch;

  return prisma.$transaction(async (tx) => {
    if (medias) {
      await tx.postMedia.deleteMany({ where: { postId: id } });
      await tx.postMedia.createMany({
        data: medias.map((m) => ({
          postId: id,
          mediaAssetId: m.mediaAssetId,
          order: m.order,
        })),
      });
    }

    return tx.scheduledPost.update({
      where: { id },
      data: {
        ...(caption !== undefined ? { caption } : {}),
        ...(scheduledFor !== undefined ? { scheduledFor } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(type !== undefined ? { type } : {}),
      },
      include: POST_INCLUDE,
    });
  });
}

function updateStatus(id, status, extras = {}) {
  return prisma.scheduledPost.update({
    where: { id },
    data: { status, ...extras },
    include: POST_INCLUDE,
  });
}

function deleteById(id) {
  return prisma.scheduledPost.delete({ where: { id } });
}

module.exports = {
  create,
  findById,
  findAllByUserId,
  updateEditable,
  updateStatus,
  deleteById,
};