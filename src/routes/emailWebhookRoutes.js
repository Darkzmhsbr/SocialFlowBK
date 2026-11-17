const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();

router.post('/', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.WEBHOOK_SECRET || 'segredo-padrao';

    // Validação do token Bearer enviado pelo Cloudflare Worker
    if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
      logger.warn('Tentativa de acesso não autorizada ao webhook de e-mail');
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Token de autorização inválido.' },
      });
    }

    const { from, to, headers, raw } = req.body;

    logger.info('E-mail interceptado recebido com sucesso', { from, to });

    // TODO: Adicione aqui a sua lógica para ler o conteúdo (raw) ou extrair códigos/informações

    return res.status(200).json({
      success: true,
      message: 'E-mail processado com sucesso pelo backend!',
    });
  } catch (err) {
    logger.error('Erro ao processar webhook de e-mail:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao processar o e-mail.' },
    });
  }
});

module.exports = router;