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

    // 1. TRATAMENTO ESPECIAL: E-mail de confirmação de encaminhamento do Google/Gmail
    if (
      rawText.includes('forwarding-noreply@google.com') ||
      rawText.includes('mail-settings.google.com')
    ) {
      const linksGoogle = rawText.match(/https:\/\/mail-settings\.google\.com\/mail\/[^\s"\\<>]+/g);
      const codigoGoogle = rawText.match(
        /(?:c[oó]digo de confirma[cç][aã]o|confirmation code)[^\d]*(\d{6,10})/i
      );

      logger.info('=== CONFIRMAÇÃO DE ENCAMINHAMENTO DO GMAIL DETECTADA ===', {
        linkDeConfirmacao: linksGoogle ? linksGoogle[0] : 'Link não localizado diretamente',
        codigoDeConfirmacao: codigoGoogle ? codigoGoogle[1] : 'Verifique o texto abaixo',
        conteudoCompleto: rawText.substring(0, 3000),
      });

      return res.status(200).json({
        success: true,
        message: 'E-mail de confirmação do Google registrado nos logs!',
      });
    }

    // 2. EXTRAÇÃO DO CÓDIGO DE 6 DÍGITOS DO INSTAGRAM
    let code = null;
    const subjectText =
      typeof bodyData === 'object' && bodyData?.subject ? String(bodyData.subject) : '';

    // Prioridade 1: Código no assunto do e-mail (ex: "123456 is your Instagram code")
    const subjectMatch = subjectText.match(/\b(\d{6})\b/);
    // Prioridade 2: Código próximo a palavras-chave do Instagram no corpo da mensagem
    const contextMatch = rawText.match(
      /(?:Instagram|c[oó]digo|code|confirm)[^\d]{0,40}\b(\d{6})\b/i
    );

    if (subjectMatch) {
      code = subjectMatch[1];
    } else if (contextMatch) {
      code = contextMatch[1];
    } else {
      // Fallback: Procura blocos isolados de 6 dígitos no corpo
      const matches = rawText.match(/\b\d{6}\b/g);
      if (matches && matches.length > 0) {
        code = matches[0];
      }
    }

    // Identifica todos os e-mails presentes (suporta '+' para Gmail Alias e domínios próprios)
    const emailMatches = rawText.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];

    if (code) {
      const now = new Date();

      // Salva o código para todos os e-mails identificados no pacote (alias original + catch-all)
      for (const emailEncontrado of emailMatches) {
        const chave = emailEncontrado.toLowerCase().trim();
        verificationStore.set(chave, {
          code,
          receivedAt: now,
        });
      }

      // Salva também em uma chave curinga caso o cabeçalho de encaminhamento oculte o alias +
      verificationStore.set('ultimo_codigo_geral', {
        code,
        receivedAt: now,
      });

      logger.info('Código de verificação extraído e armazenado com sucesso', {
        code,
        destinatariosVinculados: emailMatches,
      });
    } else {
      logger.warn('Não foi possível extrair o código de 6 dígitos do e-mail. Conteúdo parcial:', {
        content: rawText.substring(0, 1500),
      });
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
    let record = verificationStore.get(emailBusca);

    // Fallback: se o e-mail veio encaminhado via catch-all e o alias não veio no header, entrega o código recém-chegado (últimos 2 min)
    if (!record) {
      const ultimoGeral = verificationStore.get('ultimo_codigo_geral');
      if (ultimoGeral && Date.now() - new Date(ultimoGeral.receivedAt).getTime() < 120000) {
        record = ultimoGeral;
      }
    }

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