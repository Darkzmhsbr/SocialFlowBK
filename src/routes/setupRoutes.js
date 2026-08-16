// Rotas de setup / seed. Idempotente, protegido por SETUP_TOKEN.
// Handler inline (sem controller separado, sem asyncHandler) para minimizar
// pontos de falha na cadeia de imports. Uma vez que o user default estiver
// criado, este arquivo pode ficar aqui ou ser removido — a rota é segura
// enquanto SETUP_TOKEN não vazar.

const { Router } = require('express');
const prisma = require('../config/database');
const logger = require('../utils/logger');

const router = Router();

// GET /api/setup/default-user?token=SEU_TOKEN
router.get('/default-user', async (req, res) => {
  const setupToken = process.env.SETUP_TOKEN;
  const providedToken = req.query.token || req.headers['x-setup-token'];

  if (!setupToken) {
    return res.status(500).json({
      success: false,
      error: { code: 'CONFIG_ERROR', message: 'SETUP_TOKEN não configurado no servidor.' },
    });
  }

  if (providedToken !== setupToken) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Token de setup inválido.' },
    });
  }

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

module.exports = router;