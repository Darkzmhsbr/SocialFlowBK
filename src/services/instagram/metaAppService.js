// Rodada 10: each user can register his own Instagram app (App Meta page).
// When present, his Instagram connections use that app instead of the
// server's default one (META_APP_ID / META_APP_SECRET):
//   - isolated risk: if Meta restricts one app, the others keep working
//   - separate API quotas per app
//   - each partner manages his own testers in his own app
//
// The App Secret is stored encrypted (same utils/crypto used for tokens)
// and is NEVER returned by the API — only its last 4 characters.
// Credentials are verified by the first successful Instagram connection.

const prisma = require('../../config/database');
const { encryptToken, decryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const env = require('../../config/env');
const logger = require('../../utils/logger');

// Instagram App ID: digits. Instagram App Secret: 32 hex characters.
const APP_ID_RE = /^\d{6,25}$/;
const APP_SECRET_RE = /^[a-f0-9]{32}$/i;

function cleanAppId(value) {
  const appId = String(value || '').replace(/\s+/g, '');
  if (!APP_ID_RE.test(appId)) {
    throw new AppError(
      ErrorCodes.META_APP_INVALID,
      'ID do app inválido. Use o "ID do app do Instagram" (só números), em Casos de uso › API do Instagram › Configuração da API com login do Instagram.',
      400
    );
  }
  return appId;
}

function cleanAppSecret(value) {
  const secret = String(value || '').replace(/\s+/g, '');
  if (!APP_SECRET_RE.test(secret)) {
    throw new AppError(
      ErrorCodes.META_APP_INVALID,
      'Chave secreta inválida. Use a "Chave secreta do app do Instagram" (32 caracteres) — não a chave do app principal da Meta.',
      400
    );
  }
  return secret;
}

function secretLast4(encrypted) {
  try {
    return decryptToken(encrypted).slice(-4);
  } catch {
    return null;
  }
}

function toPublic(credential) {
  if (!credential) return null;
  return {
    appId: credential.appId,
    secretLast4: secretLast4(credential.appSecretEncrypted),
    status: credential.status,
    verifiedAt: credential.verifiedAt,
    lastErrorMessage: credential.lastErrorMessage,
    lastErrorAt: credential.lastErrorAt,
    updatedAt: credential.updatedAt,
  };
}

async function getStatus(userId) {
  const credential = await prisma.metaAppCredential.findUnique({ where: { userId } });
  const [viaOwnApp, total] = await Promise.all([
    credential
      ? prisma.instagramAccount.count({ where: { userId, metaAppCredentialId: credential.id } })
      : Promise.resolve(0),
    prisma.instagramAccount.count({ where: { userId } }),
  ]);
  return {
    credential: toPublic(credential),
    redirectUri: env.meta.redirectUri,
    usingOwnApp: Boolean(credential),
    accounts: { viaOwnApp, viaDefaultApp: total - viaOwnApp, total },
  };
}

/**
 * Create or update. appSecret may be omitted on update when the appId is
 * unchanged (keeps the stored secret). Any change resets the status to
 * PENDING until the next successful connection.
 */
async function saveCredentials(userId, { appId, appSecret } = {}) {
  const cleanId = cleanAppId(appId);
  const existing = await prisma.metaAppCredential.findUnique({ where: { userId } });

  let encrypted;
  if (appSecret) {
    encrypted = encryptToken(cleanAppSecret(appSecret));
  } else if (existing && existing.appId === cleanId) {
    encrypted = existing.appSecretEncrypted;
  } else {
    throw new AppError(ErrorCodes.META_APP_INVALID, 'Informe a chave secreta do app do Instagram.', 400);
  }

  const data = {
    appId: cleanId,
    appSecretEncrypted: encrypted,
    status: 'PENDING',
    verifiedAt: null,
    lastErrorMessage: null,
    lastErrorAt: null,
  };
  const saved = await prisma.metaAppCredential.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  logger.info('Meta app credentials saved', { userId, appId: cleanId, replaced: Boolean(existing) });
  return toPublic(saved);
}

/**
 * Back to the default app. Profiles already connected keep publishing
 * (their tokens stay valid and are refreshed without the app secret); new
 * connections use the default app.
 */
async function removeCredentials(userId) {
  const existing = await prisma.metaAppCredential.findUnique({ where: { userId } });
  if (!existing) return { removed: false };
  await prisma.metaAppCredential.delete({ where: { userId } });
  logger.info('Meta app credentials removed', { userId, appId: existing.appId });
  return { removed: true };
}

/** For the OAuth flow. null = use the default app. */
async function getAppForUser(userId) {
  const credential = await prisma.metaAppCredential.findUnique({ where: { userId } });
  if (!credential) return null;
  return {
    credentialId: credential.id,
    appId: credential.appId,
    appSecret: decryptToken(credential.appSecretEncrypted),
  };
}

async function getAppByCredentialId(credentialId) {
  const credential = await prisma.metaAppCredential.findUnique({ where: { id: credentialId } });
  if (!credential) return null;
  return {
    credentialId: credential.id,
    appId: credential.appId,
    appSecret: decryptToken(credential.appSecretEncrypted),
  };
}

async function markVerified(credentialId) {
  await prisma.metaAppCredential
    .update({
      where: { id: credentialId },
      data: { status: 'VERIFIED', verifiedAt: new Date(), lastErrorMessage: null, lastErrorAt: null },
    })
    .catch((err) => logger.warn('markVerified failed', { credentialId, error: err.message }));
}

/** Store a readable reason for a failed connection through the user's app. */
async function recordError(credentialId, error) {
  const meta = error?.debug || {};
  const raw = String(meta.error_message || meta.message || error?.message || 'Falha desconhecida');
  let hint = raw;
  if (/redirect_uri|verification code/i.test(raw)) {
    hint =
      'A Meta recusou o código. Confira: (1) a URL de retorno está cadastrada exatamente igual no app; (2) o ID e a chave secreta são os do APP DO INSTAGRAM (não do app principal).';
  } else if (/client_secret|app secret|Invalid OAuth|client_id/i.test(raw)) {
    hint = 'ID ou chave secreta do app incorretos. Copie de novo do painel do app (seção Instagram).';
  }
  await prisma.metaAppCredential.update({
    where: { id: credentialId },
    data: { status: 'ERROR', lastErrorMessage: hint.slice(0, 1000), lastErrorAt: new Date() },
  });
}

module.exports = {
  getStatus,
  saveCredentials,
  removeCredentials,
  getAppForUser,
  getAppByCredentialId,
  markVerified,
  recordError,
};