const { Router } = require('express');
const logger = require('../utils/logger'); // Verifique se o caminho do logger está correto no seu projeto

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

    const { from, to, headers, raw, text, subject, html } = req.body;

    logger.info('E-mail interceptado recebido com sucesso', { from, to, subject });

    // Concatena todas as fontes de texto para varredura
    const emailContent = [raw, text, html, subject].filter(Boolean).join(' ');

    // REGEX REFINADA: Procura por padrões comuns de códigos de verificação do Instagram ou 6 dígitos isolados
    // Ex: "083162 é o seu código", "código: 083162", ou qualquer 6 dígitos que venha após termos como "Instagram", "código" ou "code"
    let codeMatch = null;
    
    // Tenta achar 6 dígitos perto de palavras-chave do Instagram
    const regexContexto = /(?:instagram|c[oó]digo|code|confirma[çc][ãa]o)[^\d]{0,30}(\d{6})/i.exec(emailContent);
    if (regexContexto) {
      codeMatch = [regexContexto[1]];
    } else {
      // Fallback: Procura por qualquer bloco de 6 dígitos que não faça parte de uma URL ou IP
      const matches = emailContent.match(/\b\d{6}\b/g);
      if (matches && matches.length > 0) {
        // Pega o último ou primeiro bloco de 6 dígitos encontrado que não seja uma porta/IP
        codeMatch = [matches[0]];
      }
    }

    // Identifica o destinatário alvo (catch-all)
    const destinatarioAlvo = to || emailContent.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0];

    if (codeMatch && (destinatarioAlvo || to)) {
      const code = codeMatch[0];
      const chaveArmazenamento = (to || destinatarioAlvo).toLowerCase().trim();
      
      verificationStore.set(chaveArmazenamento, {
        code,
        receivedAt: new Date(),
      });
      logger.info('Código de verificação extraído e armazenado com sucesso', { to: chaveArmazenamento, code });
    } else {
      logger.warn('Não foi possível extrair o código de 6 dígitos do e-mail. Conteúdo parcial:', { content: emailContent.substring(0, 300) });
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