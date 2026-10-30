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

// GET  /api/setup/migrate-rodada5-health?token=SEU_TOKEN   (pelo navegador)
// POST /api/setup/migrate-rodada5-health?token=SEU_TOKEN   (curl/Postman)
//
// Rodada 5 (account health + notifications) schema migration:
//   - instagram_accounts: 6 nullable columns (publishPausedUntil,
//     pauseReason, lastErrorCode, lastErrorMessage, lastErrorAt,
//     lastHealthCheckAt)
//   - notifications: new table + FK to users (ON DELETE CASCADE) + 3 indexes
// Names match what Prisma generates for schema.prisma, so a future
// `prisma db push` sees no drift.
//
// Run it RIGHT AFTER the backend deploy goes Active (until then, account
// queries fail because the new Prisma client expects the new columns).
// Idempotent (IF NOT EXISTS everywhere) and transactional. Existing rows
// only gain NULLs — nothing is deleted or rewritten.
const RODADA5_ACCOUNT_COLUMNS = [
  'publishPausedUntil',
  'pauseReason',
  'lastErrorCode',
  'lastErrorMessage',
  'lastErrorAt',
  'lastHealthCheckAt',
];
const RODADA5_INDEXES = [
  'notifications_userId_createdAt_idx',
  'notifications_userId_readAt_idx',
  'notifications_dedupeKey_idx',
];

async function migrateRodada5Health(req, res) {
  if (!assertSetupToken(req, res)) return;

  try {
    const before = await inspectRodada5Schema();
    if (before.missingColumns.length === 0 && before.tableExists && before.missingIndexes.length === 0) {
      return res.json({
        success: true,
        data: {
          applied: { columnsAdded: [], tableCreated: false, indexesCreated: [] },
          schema: before,
          message: 'Nada a migrar. Colunas, tabela de notificações e índices já existem.',
        },
      });
    }

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'ALTER TABLE "instagram_accounts" ' +
          'ADD COLUMN IF NOT EXISTS "publishPausedUntil" TIMESTAMP(3), ' +
          'ADD COLUMN IF NOT EXISTS "pauseReason" TEXT, ' +
          'ADD COLUMN IF NOT EXISTS "lastErrorCode" TEXT, ' +
          'ADD COLUMN IF NOT EXISTS "lastErrorMessage" TEXT, ' +
          'ADD COLUMN IF NOT EXISTS "lastErrorAt" TIMESTAMP(3), ' +
          'ADD COLUMN IF NOT EXISTS "lastHealthCheckAt" TIMESTAMP(3)'
      ),
      prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "notifications" (' +
          '"id" TEXT NOT NULL, ' +
          '"userId" TEXT NOT NULL, ' +
          '"type" TEXT NOT NULL, ' +
          '"severity" TEXT NOT NULL DEFAULT \'info\', ' +
          '"title" TEXT NOT NULL, ' +
          '"message" TEXT, ' +
          '"instagramAccountId" TEXT, ' +
          '"postId" TEXT, ' +
          '"batchId" TEXT, ' +
          '"dedupeKey" TEXT, ' +
          '"readAt" TIMESTAMP(3), ' +
          '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
          'CONSTRAINT "notifications_pkey" PRIMARY KEY ("id"), ' +
          'CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") ' +
          'REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE' +
          ')'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "notifications_userId_createdAt_idx" ON "notifications"("userId", "createdAt")'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "notifications_userId_readAt_idx" ON "notifications"("userId", "readAt")'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "notifications_dedupeKey_idx" ON "notifications"("dedupeKey")'
      ),
    ]);

    const after = await inspectRodada5Schema();
    const applied = {
      columnsAdded: before.missingColumns.filter((c) => !after.missingColumns.includes(c)),
      tableCreated: !before.tableExists && after.tableExists,
      indexesCreated: before.missingIndexes.filter((i) => !after.missingIndexes.includes(i)),
    };

    logger.info('Rodada 5 health migration applied', { applied, schema: after });

    return res.json({
      success: true,
      data: {
        applied,
        schema: after,
        message:
          'Migração Rodada 5 concluída. Pausa automática, saúde dos perfis e notificações liberadas - pode publicar o frontend.',
      },
    });
  } catch (error) {
    logger.error('Failed to apply Rodada 5 health migration', {
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

router.get('/migrate-rodada5-health', migrateRodada5Health);
router.post('/migrate-rodada5-health', migrateRodada5Health);

// GET  /api/setup/migrate-rodada7-library?token=SEU_TOKEN   (pelo navegador)
// POST /api/setup/migrate-rodada7-library?token=SEU_TOKEN   (curl/Postman)
//
// Rodada 7 (media library) schema migration:
//   - media_folders: new table + FK to users (ON DELETE CASCADE),
//     unique (userId, name) + index (userId)
//   - media_assets: "inLibrary" BOOLEAN NOT NULL DEFAULT false, "folderId"
//     TEXT + FK to media_folders (ON DELETE SET NULL) + index
//   - first run only: every existing IMAGE goes to the library (inLibrary =
//     true). Those are the covers already uploaded — they become visible in
//     the cover picker and are protected from the automatic cleanup.
// Names match what Prisma generates for schema.prisma (no drift).
// Run RIGHT AFTER the backend deploy goes Active. Idempotent, transactional,
// nothing is deleted.
const RODADA7_INDEXES = ['media_folders_userId_name_key', 'media_folders_userId_idx', 'media_assets_folderId_idx'];

async function migrateRodada7Library(req, res) {
  if (!assertSetupToken(req, res)) return;

  try {
    const before = await inspectRodada7Schema();
    const nothingMissing =
      before.foldersTableExists &&
      before.missingColumns.length === 0 &&
      before.folderFkExists &&
      before.missingIndexes.length === 0;

    if (nothingMissing) {
      return res.json({
        success: true,
        data: {
          applied: { tableCreated: false, columnsAdded: [], foreignKeyCreated: false, indexesCreated: [], imagesMovedToLibrary: 0 },
          schema: before,
          message: 'Nada a migrar. Biblioteca e pastas já existem.',
        },
      });
    }

    const firstRun = before.missingColumns.includes('inLibrary');

    const results = await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "media_folders" (' +
          '"id" TEXT NOT NULL, ' +
          '"userId" TEXT NOT NULL, ' +
          '"name" TEXT NOT NULL, ' +
          '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
          '"updatedAt" TIMESTAMP(3) NOT NULL, ' +
          'CONSTRAINT "media_folders_pkey" PRIMARY KEY ("id"), ' +
          'CONSTRAINT "media_folders_userId_fkey" FOREIGN KEY ("userId") ' +
          'REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE' +
          ')'
      ),
      prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "media_folders_userId_name_key" ON "media_folders"("userId", "name")'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "media_folders_userId_idx" ON "media_folders"("userId")'
      ),
      prisma.$executeRawUnsafe(
        'ALTER TABLE "media_assets" ' +
          'ADD COLUMN IF NOT EXISTS "inLibrary" BOOLEAN NOT NULL DEFAULT false, ' +
          'ADD COLUMN IF NOT EXISTS "folderId" TEXT'
      ),
      prisma.$executeRawUnsafe(
        'DO $$ BEGIN ' +
          'IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = \'media_assets_folderId_fkey\') THEN ' +
          'ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_folderId_fkey" ' +
          'FOREIGN KEY ("folderId") REFERENCES "media_folders"("id") ON DELETE SET NULL ON UPDATE CASCADE; ' +
          'END IF; END $$'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "media_assets_folderId_idx" ON "media_assets"("folderId")'
      ),
      prisma.$executeRawUnsafe(
        firstRun
          ? 'UPDATE "media_assets" SET "inLibrary" = true WHERE "type" = \'IMAGE\' AND "inLibrary" = false'
          : 'SELECT 1'
      ),
    ]);

    const after = await inspectRodada7Schema();
    const applied = {
      tableCreated: !before.foldersTableExists && after.foldersTableExists,
      columnsAdded: before.missingColumns.filter((c) => !after.missingColumns.includes(c)),
      foreignKeyCreated: !before.folderFkExists && after.folderFkExists,
      indexesCreated: before.missingIndexes.filter((i) => !after.missingIndexes.includes(i)),
      imagesMovedToLibrary: firstRun ? Number(results[results.length - 1]) || 0 : 0,
    };

    logger.info('Rodada 7 library migration applied', { applied, schema: after });

    return res.json({
      success: true,
      data: {
        applied,
        schema: after,
        message: 'Migração Rodada 7 concluída. Biblioteca com pastas liberada - pode publicar o frontend.',
      },
    });
  } catch (error) {
    logger.error('Failed to apply Rodada 7 library migration', {
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

router.get('/migrate-rodada7-library', migrateRodada7Library);
router.post('/migrate-rodada7-library', migrateRodada7Library);

// GET  /api/setup/migrate-rodada8-account-folders?token=SEU_TOKEN   (pelo navegador)
// POST /api/setup/migrate-rodada8-account-folders?token=SEU_TOKEN   (curl/Postman)
//
// Rodada 8 (profile folders) schema migration:
//   - account_folders: new table + FK users (CASCADE), unique (userId, name),
//     index (userId)
//   - account_folder_members: new table, PK (folderId, instagramAccountId),
//     FKs to account_folders and instagram_accounts (both CASCADE: deleting
//     a folder or a profile only removes the link), index (instagramAccountId)
// Names match what Prisma generates for schema.prisma (no drift).
// Run RIGHT AFTER the backend deploy goes Active. Idempotent,
// transactional, existing data untouched.
const RODADA8_INDEXES = [
  'account_folders_userId_name_key',
  'account_folders_userId_idx',
  'account_folder_members_instagramAccountId_idx',
];

async function migrateRodada8AccountFolders(req, res) {
  if (!assertSetupToken(req, res)) return;

  try {
    const before = await inspectRodada8Schema();
    if (before.foldersTable && before.membersTable && before.missingIndexes.length === 0) {
      return res.json({
        success: true,
        data: {
          applied: { tablesCreated: [], indexesCreated: [] },
          schema: before,
          message: 'Nada a migrar. As pastas de perfis já existem.',
        },
      });
    }

    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "account_folders" (' +
          '"id" TEXT NOT NULL, ' +
          '"userId" TEXT NOT NULL, ' +
          '"name" TEXT NOT NULL, ' +
          '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
          '"updatedAt" TIMESTAMP(3) NOT NULL, ' +
          'CONSTRAINT "account_folders_pkey" PRIMARY KEY ("id"), ' +
          'CONSTRAINT "account_folders_userId_fkey" FOREIGN KEY ("userId") ' +
          'REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE' +
          ')'
      ),
      prisma.$executeRawUnsafe(
        'CREATE UNIQUE INDEX IF NOT EXISTS "account_folders_userId_name_key" ON "account_folders"("userId", "name")'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "account_folders_userId_idx" ON "account_folders"("userId")'
      ),
      prisma.$executeRawUnsafe(
        'CREATE TABLE IF NOT EXISTS "account_folder_members" (' +
          '"folderId" TEXT NOT NULL, ' +
          '"instagramAccountId" TEXT NOT NULL, ' +
          '"createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, ' +
          'CONSTRAINT "account_folder_members_pkey" PRIMARY KEY ("folderId", "instagramAccountId"), ' +
          'CONSTRAINT "account_folder_members_folderId_fkey" FOREIGN KEY ("folderId") ' +
          'REFERENCES "account_folders"("id") ON DELETE CASCADE ON UPDATE CASCADE, ' +
          'CONSTRAINT "account_folder_members_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") ' +
          'REFERENCES "instagram_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE' +
          ')'
      ),
      prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS "account_folder_members_instagramAccountId_idx" ON "account_folder_members"("instagramAccountId")'
      ),
    ]);

    const after = await inspectRodada8Schema();
    const applied = {
      tablesCreated: [
        !before.foldersTable && after.foldersTable ? 'account_folders' : null,
        !before.membersTable && after.membersTable ? 'account_folder_members' : null,
      ].filter(Boolean),
      indexesCreated: before.missingIndexes.filter((i) => !after.missingIndexes.includes(i)),
    };

    logger.info('Rodada 8 account folders migration applied', { applied, schema: after });

    return res.json({
      success: true,
      data: {
        applied,
        schema: after,
        message: 'Migração Rodada 8 concluída. Pastas de perfis liberadas - pode publicar o frontend.',
      },
    });
  } catch (error) {
    logger.error('Failed to apply Rodada 8 account folders migration', {
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

router.get('/migrate-rodada8-account-folders', migrateRodada8AccountFolders);
router.post('/migrate-rodada8-account-folders', migrateRodada8AccountFolders);

async function inspectRodada8Schema() {
  const tables = await prisma.$queryRaw`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = current_schema()
      AND table_name IN ('account_folders', 'account_folder_members')
  `;
  const present = new Set(tables.map((t) => t.table_name));
  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename IN ('account_folders', 'account_folder_members')
  `;
  const presentIndexes = new Set(indexes.map((i) => i.indexname));
  return {
    foldersTable: present.has('account_folders'),
    membersTable: present.has('account_folder_members'),
    missingIndexes: RODADA8_INDEXES.filter((i) => !presentIndexes.has(i)),
  };
}

async function inspectRodada7Schema() {
  const [table] = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'media_folders'
    ) AS "exists"
  `;
  const columns = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'media_assets'
  `;
  const present = new Set(columns.map((c) => c.column_name));
  const [fk] = await prisma.$queryRaw`
    SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'media_assets_folderId_fkey') AS "exists"
  `;
  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename IN ('media_folders', 'media_assets')
  `;
  const presentIndexes = new Set(indexes.map((i) => i.indexname));
  return {
    foldersTableExists: Boolean(table?.exists),
    missingColumns: ['inLibrary', 'folderId'].filter((c) => !present.has(c)),
    folderFkExists: Boolean(fk?.exists),
    missingIndexes: RODADA7_INDEXES.filter((i) => !presentIndexes.has(i)),
  };
}

async function inspectRodada5Schema() {
  const columns = await prisma.$queryRaw`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'instagram_accounts'
  `;
  const present = new Set(columns.map((c) => c.column_name));
  const [table] = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'notifications'
    ) AS "exists"
  `;
  const indexes = await prisma.$queryRaw`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = current_schema() AND tablename = 'notifications'
  `;
  const presentIndexes = new Set(indexes.map((i) => i.indexname));
  return {
    missingColumns: RODADA5_ACCOUNT_COLUMNS.filter((c) => !present.has(c)),
    tableExists: Boolean(table?.exists),
    missingIndexes: RODADA5_INDEXES.filter((i) => !presentIndexes.has(i)),
  };
}

module.exports = router;