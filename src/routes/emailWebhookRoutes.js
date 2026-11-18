const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();

// Armazenamento em memória temporário para os códigos de verificação por e-mail
const verificationStore = new Map();

router.post('/', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.WEBHOOK_SECRET || 'segredo-padrao';

    // Validação do token Bearer enviado pelo Cloudflare Worker / Gmail Forwarder
    if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
      logger.warn('Tentativa de acesso não autorizada ao webhook de e-mail');
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Token de autorização inválido.' },
      });
    }

    // Unifica qualquer tipo de corpo recebido (JSON, texto cru ou stringify geral) para garantir leitura integral
    const bodyData = req.body;
    const rawText = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);

    logger.info('E-mail interceptado recebido com sucesso. Analisando conteúdo...');

    // REGEX BLINDADA GLOBAL: Varre todo o texto em busca de qualquer bloco isolado de 6 dígitos
    let code = null;
    const matches = rawText.match(/\b\d{6}\b/g);

    if (matches && matches.length > 0) {
      // Pega o último código de 6 dígitos encontrado (geralmente o mais recente no corpo do e-mail)
      code = matches[matches.length - 1];
    }

    // Identifica o destinatário alvo (catch-all ou alias customizado)
    const emailMatches = rawText.match(/[\w.-]+@[\w.-]+\.\w+/g);
    const destinatarioAlvo = emailMatches ? emailMatches.find(e => e.includes('criacaoacelerada') || e.includes('primeirodate')) : null;

    if (code && destinatarioAlvo) {
      const chaveArmazenamento = destinatarioAlvo.toLowerCase().trim();
      
      verificationStore.set(chaveArmazenamento, {
        code,
        receivedAt: new Date(),
      });
      logger.info('Código de verificação extraído e armazenado com sucesso', { to: chaveArmazenamento, code });
    } else {
      logger.warn('Não foi possível extrair o código de 6 dígitos do e-mail. Conteúdo parcial:', { content: rawText.substring(0, 300) });
    }

    return res.status(200).json({
      success: true,
      message: 'E-mail processado e analisado!',
    });
  } catch (err) {
    logger.error('Erro ao processar webhook de e-mail:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao processar o e-mail.' },
    });
  }
});

// Endpoint GET para o bot buscar o código de verificação
router.get('/get-latest-email', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.WEBHOOK_SECRET || 'segredo-padrao';

    if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Token de autorização inválido.' },
      });
    }

    const { to } = req.query;
    if (!to) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Parâmetro "to" é obrigatório.' },
      });
    }

    const emailBusca = to.toLowerCase().trim();
    const record = verificationStore.get(emailBusca);
    
    if (!record) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Nenhum código encontrado para este e-mail.' },
      });
    }

    return res.status(200).json({
      success: true,
      code: record.code,
      receivedAt: record.receivedAt,
    });
  } catch (err) {
    logger.error('Erro ao buscar código de verificação:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao buscar o código.' },
    });
  }
});

module.exports = router;