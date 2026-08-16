// Controller de setup / seed. Idempotente e protegido por SETUP_TOKEN.
// Usado uma vez logo após deploy para garantir que o user default existe
// no banco antes do primeiro fluxo de conexão de conta Instagram.
// Enquanto o app não tem sistema de login real, o backend usa
// process.env.DEFAULT_USER_ID como dono de todas as contas conectadas.

const asyncHandler = require('../middleware/asyncHandler');
const prisma = require('../config/database');
const logger = require('../utils/logger');

const seedDefaultUser = asyncHandler(async (req, res) => {
  const setupToken = process.env.SETUP_TOKEN;
  const providedToken = req.query.token || req.headers['x-setup-token'];

  if (!setupToken) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'CONFIG_ERROR',
        message: 'SETUP_TOKEN não configurado no servidor.',
      },
    });
  }

  if (providedToken !== setupToken) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Token de setup inválido.',
      },
    });
  }

  const userId = process.env.DEFAULT_USER_ID;
  if (!userId) {
    return res.status(500).json({
      success: false,
      error: {
        code: 'CONFIG_ERROR',
        message: 'DEFAULT_USER_ID não configurado no servidor.',
      },
    });
  }

  try {
    // Upsert com defaults conservadores. Se o schema exigir mais colunas
    // NOT NULL sem default, o erro do Prisma cai no catch abaixo e
    // é devolvido na resposta HTTP para diagnóstico imediato.
    const user = await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        email: `default+${String(userId).slice(0, 8)}@zenyxvips.com`,
        name: 'Default User',
      },
    });

    logger.info('Default user seeded', { userId: user.id });

    return res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email ?? null,
          name: user.name ?? null,
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

module.exports = { seedDefaultUser };