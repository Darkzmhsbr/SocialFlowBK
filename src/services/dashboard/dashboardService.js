// Composes the dashboard payload from several stats queries into a single
// object. Everything runs in parallel via Promise.all so the endpoint stays
// fast even as more widgets get added later.

const statsRepository = require('../../database/statsRepository');

async function getStats(userId) {
  const [
    connectedAccounts,
    scheduledPosts,
    publishedThisMonth,
    drafts,
    activity,
    upcomingPosts,
  ] = await Promise.all([
    statsRepository.countConnectedAccounts(userId),
    statsRepository.countPostsByStatus(userId, ['SCHEDULED', 'QUEUED', 'PUBLISHING']),
    statsRepository.countPublishedThisMonth(userId),
    statsRepository.countPostsByStatus(userId, ['DRAFT']),
    statsRepository.getDailyActivity(userId, 14),
    statsRepository.getUpcomingPosts(userId, 5),
  ]);

  return {
    counts: {
      connectedAccounts,
      scheduledPosts,
      publishedThisMonth,
      drafts,
    },
    activity,
    upcomingPosts: upcomingPosts.map(toUpcomingShape),
  };
}

// Trims the raw Prisma object to the fields the dashboard needs, matching
// the shape scheduledPostService uses so the frontend has a consistent
// PostCard-like structure everywhere.
function toUpcomingShape(post) {
  return {
    id: post.id,
    type: post.type,
    caption: post.caption,
    scheduledFor: post.scheduledFor,
    instagramAccount: post.instagramAccount,
    thumbnail: post.medias[0]?.mediaAsset
      ? {
          type: post.medias[0].mediaAsset.type,
          url: post.medias[0].mediaAsset.url,
        }
      : null,
    mediaCount: post.medias.length,
  };
}

module.exports = { getStats };