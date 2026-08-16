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

module.exports = router;