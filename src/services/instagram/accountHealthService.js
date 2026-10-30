// Rodada 5: everything about "is this Instagram account still able to
// publish?" lives here.
//
//   classifyMetaError()  - turns a Meta error (AppError.debug) into a kind:
//        RATE_LIMIT      API call quota (codes 4, 17, 32, 613, 80xxx)
//        PUBLISH_LIMIT   daily publish quota (code 9 / subcode 2207042)
//        ACTION_BLOCKED  Instagram blocked the action (subcode 2207051)
//        ACCOUNT_DOWN    account inactive / checkpoint / restricted (2207050),
//                        permissions removed (10, 200)
//        TOKEN_INVALID   session/token invalidated (190) — expired, password
//                        changed, logged out, account disabled
//        OTHER           anything else (normal retry rules apply)
//   pauseAccount()       - sets publishPausedUntil; the worker's claim skips
//                          the account, its posts stay SCHEDULED and resume.
//   markAccountDown()    - status ERROR/TOKEN_EXPIRED; posts stay queued until
//                          the user reconnects (reconnect clears everything).
//   runHealthChecks()    - periodic: 1 light Meta call per account every
//                          30 min + automatic token refresh before expiry.
//
// The exact Meta codes are documented loosely and change over time; every
// classification is logged with code/subcode so it can be tuned later.

const prisma = require('../../config/database');
const instagramApiClient = require('../../integrations/instagram/instagramApiClient');
const notificationService = require('../notifications/notificationService');
const { decryptToken, encryptToken } = require('../../utils/crypto');
const { AppError, ErrorCodes } = require('../../utils/errors');
const env = require('../../config/env');
const logger = require('../../utils/logger');

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613]);
const PERMISSION_CODES = new Set([10, 200]);

/**
 * @param {Error} error
 * @param {{ context?: 'publish'|'health' }} [opts]
 * @returns {{ kind: string, code: number|null, subcode: number|null, message: string }}
 */
function classifyMetaError(error, { context = 'publish' } = {}) {
  const meta = error instanceof AppError ? error.debug || {} : {};
  const code = Number(meta.code ?? meta.metaCode) || null;
  const subcode = Number(meta.error_subcode ?? meta.errorSubcode) || null;
  const message = String(meta.error_user_msg || meta.message || error?.message || '');
  const result = (kind) => ({ kind, code, subcode, message });

  // Our own pre-check (content_publishing_limit) and explicit app codes.
  if (error instanceof AppError && error.code === ErrorCodes.INSTAGRAM_PUBLISH_LIMIT_REACHED) {
    return result('PUBLISH_LIMIT');
  }
  if (error instanceof AppError && error.code === ErrorCodes.INSTAGRAM_RATE_LIMITED) {
    return result('RATE_LIMIT');
  }
  if (!code && !subcode) return result('OTHER');

  if (subcode === 2207042 || code === 9) return result('PUBLISH_LIMIT');
  if (subcode === 2207051) return result('ACTION_BLOCKED');
  if (subcode === 2207050) return result('ACCOUNT_DOWN');
  if (RATE_LIMIT_CODES.has(code) || (code >= 80001 && code <= 80014)) return result('RATE_LIMIT');
  if (code === 190) return result('TOKEN_INVALID');
  if (PERMISSION_CODES.has(code)) return result('ACCOUNT_DOWN');
  // "Object does not exist / no permission" on the account itself is only
  // meaningful in the health check (/me). During publish, code 100 is also
  // used for bad media params, so it must not take the account down.
  if (context === 'health' && code === 100 && subcode === 33) return result('ACCOUNT_DOWN');
  return result('OTHER');
}

const PAUSE_TEXT = {
  RATE_LIMIT: 'limite de chamadas da Meta atingido',
  PUBLISH_LIMIT: 'limite diário de publicações do Instagram atingido',
  ACTION_BLOCKED: 'o Instagram bloqueou temporariamente as publicações deste perfil',
};

function pauseMinutesFor(kind) {
  if (kind === 'PUBLISH_LIMIT') return env.worker.publishLimitPauseMinutes;
  if (kind === 'ACTION_BLOCKED') return env.worker.actionBlockPauseMinutes;
  return env.worker.rateLimitPauseMinutes;
}

/**
 * Pause publishing on one account. Never shortens an existing longer pause.
 * Returns the effective pausedUntil.
 */
async function pauseAccount(accountId, classification) {
  const minutes = pauseMinutesFor(classification.kind);
  const until = new Date(Date.now() + minutes * 60 * 1000);
  const reason = PAUSE_TEXT[classification.kind] || 'limite da Meta atingido';

  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, userId: true, username: true, publishPausedUntil: true },
  });
  if (!account) return until;

  const effective =
    account.publishPausedUntil && account.publishPausedUntil > until ? account.publishPausedUntil : until;

  await prisma.instagramAccount.update({
    where: { id: accountId },
    data: {
      publishPausedUntil: effective,
      pauseReason: reason,
      lastErrorCode: classification.code ? String(classification.code) : classification.kind,
      lastErrorMessage: classification.message.slice(0, 1000) || reason,
      lastErrorAt: new Date(),
    },
  });

  const pending = await countPendingPosts(accountId);
  logger.warn('Instagram account publishing paused', {
    accountId,
    kind: classification.kind,
    code: classification.code,
    subcode: classification.subcode,
    until: effective,
    pending,
  });

  await notificationService.notify({
    userId: account.userId,
    type: 'ACCOUNT_PAUSED',
    severity: 'warning',
    title: `@${account.username} em pausa`,
    message: `Publicações pausadas até ${formatTime(effective)}: ${reason}. ${pending} post(s) aguardando — saem automaticamente depois da pausa.`,
    instagramAccountId: accountId,
    dedupeKey: `paused:${accountId}:${classification.kind}`,
    dedupeWindowMinutes: minutes,
  });

  return effective;
}

/**
 * Mark the account as unusable until the user reconnects it. Its posts are
 * NOT failed — the claim skips non-ACTIVE accounts, so they wait.
 */
async function markAccountDown(accountId, classification) {
  const status = classification.kind === 'TOKEN_INVALID' ? 'TOKEN_EXPIRED' : 'ERROR';
  const account = await prisma.instagramAccount.findUnique({
    where: { id: accountId },
    select: { id: true, userId: true, username: true, status: true },
  });
  if (!account) return;

  await prisma.instagramAccount.update({
    where: { id: accountId },
    data: {
      status,
      lastErrorCode: classification.code ? String(classification.code) : classification.kind,
      lastErrorMessage: classification.message.slice(0, 1000) || null,
      lastErrorAt: new Date(),
    },
  });

  const pending = await countPendingPosts(accountId);
  logger.error('Instagram account marked as down', {
    accountId,
    status,
    code: classification.code,
    subcode: classification.subcode,
    message: classification.message,
    pending,
  });

  const why =
    status === 'TOKEN_EXPIRED'
      ? 'A sessão do Instagram foi invalidada (conta desativada, senha trocada ou acesso removido).'
      : 'O Instagram informou que a conta está restrita, inativa ou sem permissão.';
  // Rodada 19A: what happens next depends on the kind of problem.
  const next =
    status === 'TOKEN_EXPIRED'
      ? 'Abra o Instagram, resolva o aviso (ex.: confirmar identidade) e use "Reconectar" — as publicações voltam sozinhas depois.'
      : 'Se for um bloqueio temporário, o SocialFlow testa o perfil sozinho e retoma a fila quando a Meta liberar. Se o Instagram pediu para confirmar a identidade, resolva no app e use "Reconectar".';
  const codeText = classification.code
    ? ` (código ${classification.code}${classification.subcode ? `/${classification.subcode}` : ''})`
    : '';

  await notificationService.notify({
    userId: account.userId,
    type: 'ACCOUNT_DOWN',
    severity: 'error',
    title: `@${account.username} com problema`,
    message: `${why}${codeText} ${pending} post(s) ficaram pausados na fila. ${next}`, // Rodada 19A: + code + next steps
    instagramAccountId: accountId,
    dedupeKey: `down:${accountId}`,
    dedupeWindowMinutes: 24 * 60,
  });
}

/**
 * Decide what to do with a Meta error for a given account.
 * @returns {Promise<{ handled: boolean, kind: string, resumeAt?: Date }>}
 */
async function handleAccountError(accountId, error, opts) {
  const classification = classifyMetaError(error, opts);
  if (['RATE_LIMIT', 'PUBLISH_LIMIT', 'ACTION_BLOCKED'].includes(classification.kind)) {
    const resumeAt = await pauseAccount(accountId, classification);
    return { handled: true, kind: classification.kind, resumeAt };
  }
  if (classification.kind === 'ACCOUNT_DOWN' || classification.kind === 'TOKEN_INVALID') {
    await markAccountDown(accountId, classification);
    return { handled: true, kind: classification.kind };
  }
  return { handled: false, kind: 'OTHER' };
}

// ---------------------------------------------------------------------------
// Periodic health check
// ---------------------------------------------------------------------------

let healthTimer = null;
let healthRunning = false;

async function runHealthChecks() {
  if (healthRunning) return;
  healthRunning = true;
  try {
    const dueBefore = new Date(Date.now() - env.health.checkEachAccountEveryMinutes * 60 * 1000);
    const notPaused = { OR: [{ publishPausedUntil: null }, { publishPausedUntil: { lt: new Date() } }] };
    // Never-checked accounts first, then the ones checked longest ago.
    const neverChecked = await prisma.instagramAccount.findMany({
      where: { status: 'ACTIVE', lastHealthCheckAt: null, AND: [notPaused] },
      take: env.health.accountsPerRun,
    });
    const remaining = env.health.accountsPerRun - neverChecked.length;
    const stale =
      remaining > 0
        ? await prisma.instagramAccount.findMany({
            where: { status: 'ACTIVE', lastHealthCheckAt: { lt: dueBefore }, AND: [notPaused] },
            orderBy: { lastHealthCheckAt: 'asc' },
            take: remaining,
          })
        : [];
    const accounts = [...neverChecked, ...stale];

    for (const account of accounts) {
      await checkOneAccount(account);
    }
    // Rodada 19A: profiles marked down by a temporary block get re-tested.
    await runRecoveryChecks();
  } catch (err) {
    logger.error('Account health run failed', { error: err.message });
  } finally {
    healthRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Rodada 19A: automatic recovery of temporarily blocked profiles
// ---------------------------------------------------------------------------
//
// Only status ERROR (restriction / block / no permission — the token may
// still be valid). TOKEN_EXPIRED (token dead: password changed, identity
// confirmation, access removed) is never re-tested: the user must reconnect,
// exactly as before.
//
// Test = read the profile AND the publishing quota with the stored token.
// Works -> ACTIVE again, queue resumes, "voltou sozinho" alert.
// Token dead (190) -> TOKEN_EXPIRED + "precisa reconectar" alert.
// Still blocked -> try again later: 30 min, 1h, 2h, 4h, then every 6h.
// A profile that falls again within 24h of coming back starts at 2h.

const RECOVERY_STEPS_MIN = [30, 60, 120, 240, 360];
const RECOVERY_PER_RUN = 10;
const recoveryAttempts = new Map(); // accountId -> consecutive failed tests
const recoveredAt = new Map(); // accountId -> when it last came back

function recoveryIntervalMs(accountId) {
  const n = recoveryAttempts.get(accountId) || 0;
  const flapped = recoveredAt.has(accountId) && Date.now() - recoveredAt.get(accountId) < 24 * 60 * 60 * 1000;
  const index = Math.min(n + (flapped ? 2 : 0), RECOVERY_STEPS_MIN.length - 1);
  return RECOVERY_STEPS_MIN[index] * 60 * 1000;
}

async function runRecoveryChecks() {
  const candidates = await prisma.instagramAccount.findMany({
    where: { status: 'ERROR' },
    orderBy: { lastHealthCheckAt: 'asc' },
    take: 50,
  });
  const due = candidates
    .filter((a) => {
      const last = (a.lastHealthCheckAt || a.lastErrorAt || new Date(0)).getTime();
      return Date.now() - last >= recoveryIntervalMs(a.id);
    })
    .slice(0, RECOVERY_PER_RUN);
  for (const account of due) {
    await tryRecoverAccount(account);
  }
  return due.length;
}

async function tryRecoverAccount(account) {
  let token;
  try {
    token = decryptToken(account.accessTokenEncrypted);
  } catch {
    return 'skipped';
  }
  try {
    await instagramApiClient.fetchAuthorizedProfile(token);
    await instagramApiClient.fetchContentPublishingLimit(account.instagramUserId, token);
  } catch (err) {
    const c = classifyMetaError(err, { context: 'health' });
    if (c.kind === 'TOKEN_INVALID') {
      recoveryAttempts.delete(account.id);
      await markAccountDown(account.id, c); // -> TOKEN_EXPIRED, "reconecte"
      return 'token_dead';
    }
    recoveryAttempts.set(account.id, (recoveryAttempts.get(account.id) || 0) + 1);
    await prisma.instagramAccount
      .update({ where: { id: account.id }, data: { lastHealthCheckAt: new Date() } })
      .catch(() => {});
    logger.info('Recovery test: profile still blocked', {
      accountId: account.id,
      kind: c.kind,
      nextTestMinutes: recoveryIntervalMs(account.id) / 60000,
    });
    return 'still_down';
  }

  // Works again.
  const updated = await prisma.instagramAccount.updateMany({
    where: { id: account.id, status: 'ERROR' }, // a reconnect in the meantime wins
    data: {
      status: 'ACTIVE',
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      lastHealthCheckAt: new Date(),
    },
  });
  if (updated.count === 0) return 'changed';
  recoveryAttempts.delete(account.id);
  recoveredAt.set(account.id, Date.now());
  await notifyAccountBack(account, 'recovered');
  logger.info('Instagram account recovered automatically', { accountId: account.id });
  return 'recovered';
}

/**
 * "Voltou" alert (bell + Telegram), used by the automatic recovery and by a
 * manual reconnect of a profile that was down. kind: 'recovered' | 'reconnected'
 */
async function notifyAccountBack(account, kind) {
  const [pending, failed] = await Promise.all([
    countPendingPosts(account.id),
    prisma.scheduledPost.count({
      where: {
        instagramAccountId: account.id,
        status: 'FAILED',
        updatedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),
  ]);
  const parts = [];
  parts.push(pending ? `${pending} post(s) da fila voltam a sair normalmente.` : 'Nenhum post estava esperando na fila.');
  if (failed) parts.push(`${failed} falharam nos últimos 7 dias: use "Republicar falhas" em Monitoramento.`);
  await notificationService.notify({
    userId: account.userId,
    type: 'ACCOUNT_RECOVERED',
    severity: 'success',
    title: kind === 'recovered' ? `✅ @${account.username} voltou sozinho` : `✅ @${account.username} reconectado`,
    message: `${kind === 'recovered' ? 'O bloqueio do Instagram acabou e o perfil está ativo de novo.' : 'Perfil conectado de novo com uma autorização nova.'} ${parts.join(' ')}`,
    instagramAccountId: account.id,
    dedupeKey: `back:${account.id}:${new Date().toISOString().slice(0, 13)}`,
    dedupeWindowMinutes: 60,
  });
}

async function checkOneAccount(account) {
  let token;
  try {
    token = decryptToken(account.accessTokenEncrypted);
  } catch (err) {
    logger.error('Health check: cannot decrypt token', { accountId: account.id, error: err.message });
    return;
  }

  try {
    await instagramApiClient.fetchAuthorizedProfile(token);
    const data = { lastHealthCheckAt: new Date() };

    // Long-lived tokens last ~60 days. Refresh before they expire so the
    // account never "falls" just because nobody reconnected it.
    const refreshBefore = new Date(Date.now() + env.health.refreshTokenDaysBeforeExpiry * 24 * 60 * 60 * 1000);
    if (account.tokenExpiresAt && account.tokenExpiresAt < refreshBefore) {
      try {
        const refreshed = await instagramApiClient.refreshLongLivedToken(token);
        if (refreshed?.accessToken) {
          data.accessTokenEncrypted = encryptToken(refreshed.accessToken);
          data.tokenExpiresAt = refreshed.expiresInSeconds
            ? new Date(Date.now() + refreshed.expiresInSeconds * 1000)
            : account.tokenExpiresAt;
          logger.info('Instagram token refreshed', { accountId: account.id, tokenExpiresAt: data.tokenExpiresAt });
        }
      } catch (err) {
        logger.warn('Instagram token refresh failed (will retry next run)', { accountId: account.id, error: err.message });
      }
    }

    await prisma.instagramAccount.update({ where: { id: account.id }, data });
  } catch (err) {
    const outcome = await handleAccountError(account.id, err, { context: 'health' });
    await prisma.instagramAccount
      .update({ where: { id: account.id }, data: { lastHealthCheckAt: new Date() } })
      .catch(() => {});
    if (!outcome.handled) {
      logger.warn('Health check failed with a non-account error (ignored)', {
        accountId: account.id,
        error: err.message,
      });
    }
  }
}

function startHealthChecks() {
  if (!env.health.enabled) {
    logger.info('Account health check disabled by ACCOUNT_HEALTH_ENABLED=false');
    return;
  }
  if (healthTimer) return;
  const everyMs = Math.max(1, env.health.runEveryMinutes) * 60 * 1000;
  healthTimer = setInterval(runHealthChecks, everyMs);
  // First run shortly after boot, not in the middle of startup.
  setTimeout(runHealthChecks, 60 * 1000).unref?.();
  logger.info('Account health check started', {
    runEveryMinutes: env.health.runEveryMinutes,
    checkEachAccountEveryMinutes: env.health.checkEachAccountEveryMinutes,
  });
}

function stopHealthChecks() {
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function countPendingPosts(accountId) {
  return prisma.scheduledPost.count({
    where: { instagramAccountId: accountId, status: { in: ['SCHEDULED', 'QUEUED', 'PUBLISHING'] } },
  });
}

function formatTime(date) {
  try {
    return new Date(date).toLocaleString('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return new Date(date).toISOString();
  }
}

module.exports = {
  classifyMetaError,
  handleAccountError,
  pauseAccount,
  markAccountDown,
  runHealthChecks,
  startHealthChecks,
  stopHealthChecks,
  // Rodada 19A
  runRecoveryChecks,
  tryRecoverAccount,
  notifyAccountBack,
  _resetRecovery() {
    recoveryAttempts.clear();
    recoveredAt.clear();
  },
};