// Rotas de setup / seed. Idempotentes, protegidas por SETUP_TOKEN.
// Handler inline (sem controller separado, sem asyncHandler) para minimizar
// pontos de falha na cadeia de imports. Uma vez que o user default estiver
// criado e o primeiro invite gerado, este arquivo pode ficar aqui - as
// rotas são seguras enquanto SETUP_TOKEN não vazar.

const { Router } = require('express');
const prisma = require('../config/database');
const logger = require('../utils/logger');
const inviteService = require('../services/invites/inviteService');

const router = Router();

// Guard shared by every route in this file. Returns true if the token check
// passed and the handler should proceed. Otherwise it already responded.
function assertSetupToken(req, res) {
  const setupToken = process.env.SETUP_TOKEN;
  const providedToken = req.query.token || req.headers['x-setup-token'];

  if (!setupToken) {
    res.status(500).json({
      success: false,
      error: { code: 'CONFIG_ERROR', message: 'SETUP_TOKEN não configurado no servidor.' },
    });
    return false;
  }
  if (providedToken !== setupToken) {
    res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Token de setup inválido.' },
    });
    return false;
  }
  return true;
}

// GET /api/setup/default-user?token=SEU_TOKEN
router.get('/default-user', async (req, res) => {
  if (!assertSetupToken(req, res)) return;

  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) {
    return res.status(500).json({
      success: false,
      error: { code: 'CONFIG_ERROR', message: 'DEFAULT_USER_ID não configurado no servidor.' },
    });
  }

  try {
    const user = await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `default+${String(userId).slice(0, 8)}@zenyxvips.com`,
      },
    });

    logger.info('Default user seeded', { userId: user.id });

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email ?? null,
          createdAt: user.createdAt ?? null,
        },
        message: 'User default garantido no banco. Pode conectar Instagram agora.',
      },
    });
  } catch (error) {
    logger.error('Failed to seed default user', {
      message: error.message,
      code: error.code,
      meta: error.meta,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: error.code || 'PRISMA_ERROR',
        message: error.message,
        details: error.meta || null,
      },
    });
  }
});

// GET /api/setup/generate-initial-invite?token=SEU_TOKEN
// Bootstrap-only: creates the very first invite code, unattached to any
// creator (because no users exist yet). Once you register with this code,
// use POST /api/invites (authenticated) to generate more for your partners.
router.get('/generate-initial-invite', async (req, res) => {
  if (!assertSetupToken(req, res)) return;

  try {
    // Never expires by default - this is the founder's own code and losing
    // it would mean re-running the bootstrap. Pass ?expiresInDays=N to set.
    const expiresInDays = req.query.expiresInDays
      ? Number(req.query.expiresInDays)
      : null;

    const invite = await inviteService.createInvite({
      createdById: null,
      expiresInDays,
      note: 'bootstrap: initial invite',
    });

    logger.info('Initial invite generated', { inviteId: invite.id });

    return res.json({
      success: true,
      data: {
        invite: inviteService.toPublicShape(invite),
        message:
          'Guarde este código. Use ele no /register para criar a primeira conta. Depois, gere convites pros sócios via POST /api/invites.',
      },
    });
  } catch (error) {
    logger.error('Failed to generate initial invite', {
      message: error.message,
      code: error.code,
      meta: error.meta,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: error.code || 'PRISMA_ERROR',
        message: error.message,
        details: error.meta || null,
      },
    });
  }
});

// POST /api/setup/promote-default-user?token=SEU_TOKEN
// Body: { targetUserId: "uuid-do-seu-user-real" }
//
// One-shot migration: moves every InstagramAccount, ScheduledPost and
// MediaAsset owned by DEFAULT_USER_ID over to a real registered user,
// then deletes the placeholder. Idempotent - running again after success
// returns "nothing to migrate" because DEFAULT_USER_ID is gone.
//
// Safe to run: the entire migration happens inside a Prisma transaction,
// so any failure rolls back to a consistent state. Nothing is deleted
// until every reassignment succeeded.
router.post('/promote-default-user', async (req, res) => {
  if (!assertSetupToken(req, res)) return;

  const sourceUserId = process.env.DEFAULT_USER_ID;
  const targetUserId = req.body?.targetUserId || req.query.targetUserId;

  if (!sourceUserId) {
    return res.status(500).json({
      success: false,
      error: { code: 'CONFIG_ERROR', message: 'DEFAULT_USER_ID não configurado.' },
    });
  }
  if (!targetUserId) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'targetUserId é obrigatório no body ou query.' },
    });
  }
  if (targetUserId === sourceUserId) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'targetUserId não pode ser igual ao DEFAULT_USER_ID.',
      },
    });
  }

  try {
    // Fast path: source doesn't exist -> nothing to do. Keeps the endpoint
    // idempotent so accidental re-runs don't error out.
    const source = await prisma.user.findUnique({ where: { id: sourceUserId } });
    if (!source) {
      return res.json({
        success: true,
        data: {
          migrated: {
            instagramAccounts: 0,
            scheduledPosts: 0,
            mediaAssets: 0,
          },
          message: 'Nada a migrar. DEFAULT_USER_ID já não existe no banco.',
        },
      });
    }

    const target = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!target) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `Usuário destino ${targetUserId} não encontrado.` },
      });
    }

    const result = await prisma.$transaction(async (tx) => {
      const igCount = await tx.instagramAccount.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });
      const postsCount = await tx.scheduledPost.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });
      const mediaCount = await tx.mediaAsset.updateMany({
        where: { userId: sourceUserId },
        data: { userId: targetUserId },
      });

      // Every FK now points to the target user. Safe to remove the placeholder.
      await tx.user.delete({ where: { id: sourceUserId } });

      return {
        instagramAccounts: igCount.count,
        scheduledPosts: postsCount.count,
        mediaAssets: mediaCount.count,
      };
    });

    logger.info('Default user promoted', {
      from: sourceUserId,
      to: targetUserId,
      migrated: result,
    });

    return res.json({
      success: true,
      data: {
        migrated: result,
        message:
          'Migração concluída. Recarregue o dashboard - os dados agora pertencem à sua conta real.',
      },
    });
  } catch (error) {
    logger.error('Failed to promote default user', {
      message: error.message,
      code: error.code,
      meta: error.meta,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: error.code || 'PRISMA_ERROR',
        message: error.message,
        details: error.meta || null,
      },
    });
  }
});

// GET  /api/setup/migrate-rodada4-batch?token=SEU_TOKEN   (pelo navegador)
// POST /api/setup/migrate-rodada4-batch?token=SEU_TOKEN   (curl/Postman)
//
// Rodada 4 (multi-profile batch posting) schema migration. Adds the
// nullable column scheduled_posts."batchId" and its index — exactly what
// schema.prisma now declares (@@index([batchId]) uses Prisma's default
// name "scheduled_posts_batchId_idx", so a future `prisma db push` sees
// no drift).
//
// Run it RIGHT AFTER the backend deploy goes Active: until it runs,
// queries on scheduled_posts fail because the new Prisma client expects
// the column.
//
// Idempotent - ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, and
// a re-run returns "nothing to migrate". Safe - both statements run inside
// one transaction, existing rows only gain batchId = NULL, nothing is
// deleted or rewritten.
// Same handler on GET and POST so it can be run straight from the browser
// address bar. Safe as GET because it is idempotent and token-protected.
async function migrateRodada4Batch(req, res) {
  if (!assertSetupToken(req, res)) return;

  try {
    const before = await inspectRodada4Schema();
    if (before.columnExists && before.indexExists) {
      return res.json({
        success: true,
        data: {
          applied: { columnAdded: false, indexCreated: false },
          schema: before,
          message: 'Nada a migrar. A coluna batchId e o índice já existem.',
        },
      });
    }

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'ALTER TABLE "scheduled_posts" ADD COLUMN IF NOT EXISTS "batchId" TEXT'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "scheduled_posts_batchId_idx" ON "scheduled_posts"("batchId")'
      ),
    ]);

    const after = await inspectRodada4Schema();
    const applied = {
      columnAdded: !before.columnExists && after.columnExists,
      indexCreated: !before.indexExists && after.indexExists,
    };

    logger.info('Rodada 4 batch migration applied', { applied, schema: after });

    return res.json({
      success: true,
      data: {
        applied,
        schema: after,
        message:
          'Migração Rodada 4 concluída. Postagem em múltiplos perfis liberada - pode publicar o frontend.',
      },
    });
  } catch (error) {
    logger.error('Failed to apply Rodada 4 batch migration', {
      message: error.message,
      code: error.code,
      meta: error.meta,
    });
    return res.status(500).json({
      success: false,
      error: {
        code: error.code || 'PRISMA_ERROR',
        message: error.message,
        details: error.meta || null,
      },
    });
  }
}

router.get('/migrate-rodada4-batch', migrateRodada4Batch);
router.post('/migrate-rodada4-batch', migrateRodada4Batch);

// Reads the live schema (information_schema / pg_indexes) instead of
// trusting Prisma, so the response reports what actually exists in the DB.
async function inspectRodada4Schema() {
  const [column] = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND table_name = 'scheduled_posts'
        AND column_name = 'batchId'
    ) AS "exists"
  `;
  const [index] = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = current_schema()
        AND tablename = 'scheduled_posts'
        AND indexname = 'scheduled_posts_batchId_idx'
    ) AS "exists"
  `;
  return {
    columnExists: Boolean(column?.exists),
    indexExists: Boolean(index?.exists),
  };
}

module.exports = router;