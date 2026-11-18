const { Router } = require('express');
const logger = '../utils/logger'; // Ajuste o caminho se necessário no seu projeto backend

const router = Router();

// Armazenamento em memória temporário para os códigos de verificação por e-mail
const verificationStore = new Map();

router.post('/', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    const expectedSecret = process.env.WEBHOOK_SECRET || 'segredo-padrao';

    // Validação do token Bearer enviado pelo Cloudflare Worker / Gmail Forwarder
    if (!authHeader || authHeader !== `Bearer ${expectedSecret}`) {
      console.warn('Tentativa de acesso não autorizada ao webhook de e-mail');
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Token de autorização inválido.' },
      });
    }

    const { from, to, headers, raw, text, subject, html } = req.body;

    console.log('E-mail interceptado recebido com sucesso', { from, to, subject });

    // Junta todas as fontes possíveis de texto do e-mail (raw, text, html, subject)
    const emailContent = [raw, text, html, subject].filter(Boolean).join(' ');

    // REGEX BLINDADA: Procura por sequências de 6 dígitos isoladas ou precedidas/sucedidas por tags ou espaços comuns do Instagram
    const codeMatch = emailContent.match(/\b\d{6}\b/) || emailContent.match(/confirm[^\d]*(\d{6})/i);

    // Destinatário alvo (pode vir no "to" ou dentro do corpo se for catch-all)
    const destinatarioAlvo = to || emailContent.match(/[\w.-]+@[\w.-]+\.\w+/)?.[0];

    if (codeMatch && (destinatarioAlvo || to)) {
      const code = codeMatch[1] || codeMatch[0];
      const chaveArmazenamento = to || destinatarioAlvo;
      
      verificationStore.set(chaveArmazenamento.toLowerCase().trim(), {
        code,
        receivedAt: new Date(),
      });
      console.log('🎉 Código de verificação extraído e armazenado com sucesso!', { to: chaveArmazenamento, code });
    } else {
      console.warn('⚠️ Não foi possível extrair o código de 6 dígitos do e-mail. Conteúdo recebido:', emailContent.substring(0, 200));
    }

    return res.status(200).json({
      success: true,
      message: 'E-mail processado!',
    });
  } catch (err) {
    console.error('Erro ao processar webhook de e-mail:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao processar o e-mail.' },
    });
  }
});

// Endpoint GET para o bot Playwright/Patchright buscar o código de verificação
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
    console.error('Erro ao buscar código de verificação:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao buscar o código.' },
    });
  }
});

module.exports = router;