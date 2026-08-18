// Aggregates everything the "Status da conta" page needs into a single
// response: identity, connection metadata, publish counters, last
// published post, and (best-effort) live Meta profile metrics.
//
// Design contract:
//   - Ownership is enforced. A user asking about someone else's account
//     gets a 404, same as if it didn't exist (no information leak).
//   - Meta profile fetch is best-effort. If the token is expired, the
//     scope is missing, or Meta is down, the page still renders — the
//     metaProfile field is just null. This matches the "fallback gracioso"
//     requirement from the spec.
//   - Direct Prisma access for the counters. Same rationale as the one
//     documented in mediaService.deleteIfOrphan (scope, not architecture).
//     Promote to scheduledPostRepository if we grow more of these.

const accountRepository = require('../../database/instagramAccountRepository');
const { decryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');
const prisma = require('../../config/database');

// Statuses that count as "pending work" for this account — anything the
// user still has queued up or waiting to publish. PUBLISHED is counted
// separately; ARCHIVED/PUBLISHING are intentionally excluded (the former
// is user-hidden, the latter is transient and confusing to surface).
const PENDING_STATUSES = ['DRAFT', 'SCHEDULED', 'QUEUED', 'FAILED'];

/**
 * @param {object} args
 * @param {string} args.accountId
 * @param {string} args.userId
 * @returns {Promise<{
 *   account: object,
 *   counts: { published: number, pending: number },
 *   lastPublished: object | null,
 *   metaProfile: { followersCount: number|null, followsCount: number|null, mediaCount: number|null } | null
 * }>}
 */
async function getAccountStatus({ accountId, userId }) {
  const account = await accountRepository.findById(accountId);
  if (!account || account.userId !== userId) {
    throw new AppError(
      ErrorCodes.INSTAGRAM_ACCOUNT_NOT_FOUND,
      'Conta do Instagram não encontrada.',
      404
    );
  }

  const [publishedCount, pendingCount, lastPublishedRow] = await Promise.all([
    prisma.scheduledPost.count({
      where: { instagramAccountId: accountId, status: 'PUBLISHED' },
    }),
    prisma.scheduledPost.count({
      where: {
        instagramAccountId: accountId,
        status: { in: PENDING_STATUSES },
      },
    }),
    prisma.scheduledPost.findFirst({
      where: { instagramAccountId: accountId, status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      include: {
        medias: {
          orderBy: { order: 'asc' },
          take: 1,
          include: { mediaAsset: true },
        },
      },
    }),
  ]);

  // Best-effort Meta fetch — never throws out of this function.
  let metaProfile = null;
  try {
    metaProfile = await fetchMetaProfileMetrics(account);
  } catch (err) {
    logger.warn('Meta profile metrics fetch failed, rendering without them', {
      accountId,
      userId,
      error: err.message,
    });
  }

  return {
    account: toAccountShape(account),
    counts: {
      published: publishedCount,
      pending: pendingCount,
    },
    lastPublished: lastPublishedRow ? toLastPublishedShape(lastPublishedRow) : null,
    metaProfile,
  };
}

function toAccountShape(account) {
  return {
    id: account.id,
    username: account.username,
    accountType: account.accountType,
    status: account.status,
    profilePictureUrl: account.profilePictureUrl,
    connectedAt: account.createdAt,
    // Token expiration lets the frontend show a "expira em X dias" hint
    // and nudge the user to reconnect before Meta invalidates it.
    tokenExpiresAt: account.tokenExpiresAt ?? null,
  };
}

function toLastPublishedShape(post) {
  const firstMedia = post.medias?.[0]?.mediaAsset;
  return {
    id: post.id,
    type: post.type,
    caption: post.caption,
    publishedAt: post.publishedAt,
    thumbnailUrl: firstMedia?.url ?? null,
    thumbnailMediaType: firstMedia?.type ?? null,
  };
}

/**
 * Hits graph.instagram.com/me for follower/follows/media counts. Kept
 * inline (not in instagramApiClient) because it's the only caller today
 * and the surface area is trivial — if we add more read-only Meta calls,
 * consolidate them into the client with a shared error/retry policy.
 *
 * The token is stored encrypted on the account row. We decrypt here
 * (same pattern as instagramPublishService) and send the plaintext to
 * Meta. The outer function already catches any error gracefully.
 */
async function fetchMetaProfileMetrics(account) {
  if (!account.accessTokenEncrypted) {
    throw new Error('Encrypted access token missing on account');
  }

  const token = decryptToken(account.accessTokenEncrypted);

  // Graph API v25 — same version the rest of the integration uses.
  const url =
    'https://graph.instagram.com/me' +
    '?fields=followers_count,follows_count,media_count' +
    `&access_token=${encodeURIComponent(token)}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Meta returned HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    followersCount: typeof data.followers_count === 'number' ? data.followers_count : null,
    followsCount: typeof data.follows_count === 'number' ? data.follows_count : null,
    mediaCount: typeof data.media_count === 'number' ? data.media_count : null,
  };
}

module.exports = {
  getAccountStatus,
};