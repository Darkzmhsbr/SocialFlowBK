const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const accountRepository = require('../../database/instagramAccountRepository');
const { encryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const logger = require('../../utils/logger');

const PROFESSIONAL_ACCOUNT_TYPES = ['BUSINESS', 'MEDIA_CREATOR'];

async function connectAndStoreAccount({ userId, accessToken, tokenExpiresAt }) {
  const profile = await instagramApiClient.fetchAuthorizedProfile(accessToken);
  logger.info('Instagram account retrieved', { instagramUserId: profile.id });

  if (profile.account_type && !PROFESSIONAL_ACCOUNT_TYPES.includes(profile.account_type)) {
    throw new AppError(
      ErrorCodes.ACCOUNT_NOT_PROFESSIONAL,
      'A conta do Instagram precisa ser uma conta profissional (Business ou Creator).',
      422
    );
  }

  const account = await accountRepository.upsertByInstagramUserId({
    userId,
    instagramUserId: String(profile.id),
    username: profile.username,
    name: profile.name || null,
    profilePictureUrl: profile.profile_picture_url || null,
    accountType: profile.account_type || null,
    accessTokenEncrypted: encryptToken(accessToken),
    tokenExpiresAt,
  });

  logger.info('Instagram account saved', { accountId: account.id });

  return account;
}

function listAccounts(userId) {
  return accountRepository.findAllByUserId(userId);
}

async function getAccount(id) {
  const account = await accountRepository.findById(id);
  if (!account) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'Conta não encontrada.', 404);
  }
  return account;
}

async function disconnectAccount(id) {
  await getAccount(id); // ensures it exists and gives a clean 404 otherwise
  await accountRepository.deleteById(id);
  logger.info('Instagram account disconnected', { accountId: id });
}

// Strips the encrypted token before anything is sent to the frontend.
function toPublicShape(account) {
  const { accessTokenEncrypted, ...publicFields } = account;
  return publicFields;
}

module.exports = {
  connectAndStoreAccount,
  listAccounts,
  getAccount,
  disconnectAccount,
  toPublicShape,
};
