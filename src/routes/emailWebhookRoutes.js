const crypto = require('crypto');
const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();

// Limites de higiene para o armazenamento temporário em memória
const VERIFICATION_TTL_MS = 10 * 60 * 1000; // 10 minutos
const MAX_STORE_ENTRIES = 500;
const ALLOWED_GOOGLE_HOSTS = new Set([
  'mail.google.com',
  'mail-settings.google.com',
  'isolated.google.com',
]);

// Armazenamento em memória temporário para os códigos de verificação por e-mail
const verificationStore = new Map();

// Armazena a última confirmação do Google para visualização autenticada
let ultimaConfirmacaoGoogle = {
  recebidoEm: null,
  links: [],
  codigos: [],
  textoDecodificado: 'Nenhum e-mail de confirmação do Google recebido ainda após este deploy.',
};

function getCorrelationId(req) {
  return req.id || req.requestId || req.headers['x-request-id'] || null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isSafeGoogleConfirmationUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' && ALLOWED_GOOGLE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function constantTimeTokenMatch(providedHeader, expectedSecret) {
  if (typeof providedHeader !== 'string' || typeof expectedSecret !== 'string') {
    return false;
  }
  const expectedHeader = `Bearer ${expectedSecret}`;
  const providedDigest = crypto.createHash('sha256').update(providedHeader, 'utf8').digest();
  const expectedDigest = crypto.createHash('sha256').update(expectedHeader, 'utf8').digest();
  return crypto.timingSafeEqual(providedDigest, expectedDigest);
}

function requireWebhookAuth(req, res, next) {
  const correlationId = getCorrelationId(req);
  const expectedSecret = process.env.WEBHOOK_SECRET;

  if (typeof expectedSecret !== 'string' || expectedSecret.trim().length === 0) {
    logger.error('Configuração obrigatória WEBHOOK_SECRET ausente ou vazia.', {
      category: 'WEBHOOK_CONFIG_ERROR',
      correlationId,
      route: req.path,
    });
    return res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'Serviço de webhook indisponível por falta de configuração de segurança.',
      },
    });
  }

  const authHeader = req.headers.authorization;
  if (!constantTimeTokenMatch(authHeader, expectedSecret)) {
    logger.warn('Tentativa de acesso não autorizada ao webhook de e-mail.', {
      category: 'WEBHOOK_AUTH_FAILED',
      correlationId,
      route: req.path,
      hasAuthHeader: Boolean(authHeader),
    });
    return res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Token de autorização inválido.' },
    });
  }

  return next();
}

function pruneVerificationStore(nowMs = Date.now()) {
  for (const [key, entry] of verificationStore.entries()) {
    if (!entry || nowMs - new Date(entry.receivedAt).getTime() > VERIFICATION_TTL_MS) {
      verificationStore.delete(key);
    }
  }

  while (verificationStore.size > MAX_STORE_ENTRIES) {
    const oldestKey = verificationStore.keys().next().value;
    if (oldestKey === undefined) break;
    verificationStore.delete(oldestKey);
  }
}

function isValidPayload(bodyData) {
  if (bodyData === null || bodyData === undefined) {
    return false;
  }
  if (typeof bodyData === 'string') {
    return bodyData.trim().length > 0;
  }
  if (typeof bodyData === 'object' && !Array.isArray(bodyData)) {
    return Object.keys(bodyData).length > 0;
  }
  return false;
}

function safeSerializeBody(bodyData) {
  if (typeof bodyData === 'string') {
    return bodyData;
  }
  try {
    return JSON.stringify(bodyData) || '';
  } catch {
    return '';
  }
}

// Função auxiliar para extrair o corpo real do e-mail sem os cabeçalhos técnicos da Cloudflare/Google
function extrairEDecodificarCorpo(bodyData) {
  let textoCorpo = '';

  if (typeof bodyData === 'object' && bodyData !== null && !Array.isArray(bodyData)) {
    // Prioriza os campos limpos (subject, text, html) antes do raw bruto
    let rawSemHeaders = typeof bodyData.raw === 'string' ? bodyData.raw : '';
    // Em um e-mail MIME raw, o corpo real sempre começa após a primeira linha em branco dupla (\r\n\r\n)
    const divisorHeaderCorpo = rawSemHeaders.indexOf('\r\n\r\n');
    if (divisorHeaderCorpo !== -1) {
      rawSemHeaders = rawSemHeaders.substring(divisorHeaderCorpo);
    }

    textoCorpo = [
      bodyData.subject ? `Subject: ${String(bodyData.subject)}` : '',
      typeof bodyData.text === 'string' ? bodyData.text : '',
      typeof bodyData.html === 'string' ? bodyData.html : '',
      rawSemHeaders,
    ]
      .filter(Boolean)
      .join('\n');
  } else if (typeof bodyData === 'string') {
    textoCorpo = bodyData;
  }

  // 1. Limpa quebras de linha Quoted-Printable (ex: "=\r\n" e "=3D")
  const textoSemQP = textoCorpo
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=')
    .replace(/=20/g, ' ');

  let blocosDecodificados = '';

  // 2. Procura blocos codificados em Base64 dentro do corpo e decodifica para UTF-8
  const possiveisBlocosBase64 =
    textoCorpo.match(/(?:[A-Za-z0-9+/]{40,}(?:\r?\n|\\r\\n|\\n)?){2,}/g) || [];
  for (const bloco of possiveisBlocosBase64) {
    try {
      const limpo = bloco.replace(/\\r|\\n|\s+/g, '');
      const decodificado = Buffer.from(limpo, 'base64').toString('utf-8');
      if (
        decodificado.includes('http') ||
        decodificado.includes('Instagram') ||
        decodificado.includes('google') ||
        decodificado.includes(' ')
      ) {
        blocosDecodificados += '\n' + decodificado;
      }
    } catch {
      // Ignora blocos que não são base64 válido
    }
  }

  return `${textoSemQP}\n${blocosDecodificados}`;
}

// Função cirúrgica para extrair APENAS o código real de 6 dígitos do Instagram
function extrairCodigoInstagram(bodyData, textoLimpo, rawString) {
  const fonteCompleta = `${textoLimpo}\n${rawString}`;

  // 1. Padrão oficial do Assunto/Corpo em Inglês: "274559 is your Instagram code"
  const matchIngles = fonteCompleta.match(/\b(\d{6})\s+is\s+your\s+Instagram\s+code/i);
  if (matchIngles) return matchIngles[1];

  // 2. Padrão oficial do Assunto/Corpo em Português: "274559 é o seu código do Instagram"
  const matchPortugues = fonteCompleta.match(
    /\b(\d{6})\s+(?:é|e)\s+o\s+seu\s+c[oó]digo\s+do\s+Instagram/i
  );
  if (matchPortugues) return matchPortugues[1];

  // 3. Padrão na linha de Subject do cabeçalho MIME: "Subject: 274559 is your..."
  const matchSubjectHeader = fonteCompleta.match(/Subject:\s*(\d{6})\b/i);
  if (matchSubjectHeader) return matchSubjectHeader[1];

  // 4. Se o objeto tiver a propriedade subject explícita
  if (typeof bodyData === 'object' && bodyData !== null && bodyData.subject) {
    const matchObjSubject = String(bodyData.subject).match(/\b(\d{6})\b/);
    if (matchObjSubject) return matchObjSubject[1];
  }

  // 5. Padrão no HTML do Instagram (código isolado após frases como "confirm your email")
  const matchContextoIg = textoLimpo.match(
    /(?:Instagram\s+code|c[oó]digo\s+do\s+Instagram|confirm\s+your\s+email|confirme\s+seu\s+email)[\s\S]{0,120}?\b(\d{6})\b/i
  );
  if (matchContextoIg && matchContextoIg[1] !== '260707') return matchContextoIg[1];

  // 6. Fallback seguro: procura 6 dígitos no corpo ignorando falsos positivos conhecidos de headers
  const falsosPositivos = new Set(['260707', '202607', '202603', '000000', '111111']);
  const todosSeisDigitos = textoLimpo.match(/\b\d{6}\b/g) || [];
  for (const candidato of todosSeisDigitos) {
    if (!falsosPositivos.has(candidato)) {
      return candidato;
    }
  }

  return null;
}

router.post('/', requireWebhookAuth, async (req, res) => {
  const correlationId = getCorrelationId(req);

  try {
    const bodyData = req.body;

    if (!isValidPayload(bodyData)) {
      logger.warn('Payload de webhook vazio ou em formato inválido.', {
        category: 'WEBHOOK_INVALID_PAYLOAD',
        correlationId,
        payloadType: Array.isArray(bodyData) ? 'array' : typeof bodyData,
      });
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Corpo da requisição vazio ou em formato inválido.',
        },
      });
    }

    const rawString = safeSerializeBody(bodyData);
    if (!rawString) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Não foi possível interpretar o corpo da requisição.',
        },
      });
    }

    const textoLimpoEDecodificado = extrairEDecodificarCorpo(bodyData);

    logger.info('E-mail interceptado recebido com sucesso.', {
      category: 'WEBHOOK_EMAIL_RECEIVED',
      correlationId,
      payloadType: typeof bodyData,
    });

    // 1. TRATAMENTO ESPECIAL: E-mail de confirmação de encaminhamento do Google/Gmail
    if (
      rawString.includes('forwarding-noreply@google.com') ||
      rawString.includes('forwarding-noreply')
    ) {
      const linksExtraidos =
        textoLimpoEDecodificado.match(
          /https:\/\/(?:mail-settings|mail|isolated)\.google\.com\/[^\s"\\<>')]+/g
        ) || [];

      const linksSeguros = [...new Set(linksExtraidos)].filter(isSafeGoogleConfirmationUrl);

      ultimaConfirmacaoGoogle = {
        recebidoEm: new Date().toISOString(),
        links: linksSeguros,
        codigos: [],
        textoDecodificado: '',
      };

      logger.info('Confirmação do Gmail processada com sucesso.', {
        category: 'WEBHOOK_GOOGLE_CONFIRMATION',
        correlationId,
        linksCount: ultimaConfirmacaoGoogle.links.length,
      });

      return res.status(200).json({
        success: true,
        message: 'E-mail de confirmação do Google decodificado!',
      });
    }

    // 2. EXTRAÇÃO CIRÚRGICA DO CÓDIGO DE 6 DÍGITOS DO INSTAGRAM
    const code = extrairCodigoInstagram(bodyData, textoLimpoEDecodificado, rawString);

    // Identifica todos os e-mails presentes (suporta '+' para Gmail Alias e domínios próprios)
    const emailMatches = rawString.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];
    const destinatariosUnicos = [...new Set(emailMatches.map((e) => e.toLowerCase().trim()))];

    if (code && destinatariosUnicos.length > 0) {
      const now = new Date();
      pruneVerificationStore(now.getTime());

      for (const chave of destinatariosUnicos) {
        verificationStore.set(chave, {
          code,
          receivedAt: now,
        });
      }

      logger.info('Código de verificação processado e armazenado.', {
        category: 'WEBHOOK_CODE_STORED',
        correlationId,
        recipientsCount: destinatariosUnicos.length,
        hasAlias: destinatariosUnicos.some((e) => e.includes('+')),
      });
    } else {
      logger.warn('Mensagem processada sem código ou destinatário identificável.', {
        category: 'WEBHOOK_CODE_NOT_FOUND',
        correlationId,
        hasCode: Boolean(code),
        recipientsCount: destinatariosUnicos.length,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'E-mail processado e analisado!',
    });
  } catch (err) {
    logger.error('Erro interno ao processar webhook de e-mail.', {
      category: 'WEBHOOK_PROCESSING_ERROR',
      correlationId,
      errorName: err?.name || 'Error',
      errorCode: err?.code || null,
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao processar o e-mail.' },
    });
  }
});

// Rota visual de apoio para confirmação de encaminhamento do Google (protegida)
router.get('/confirmacao-google', requireWebhookAuth, (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"
  );

  const safeLinks = ultimaConfirmacaoGoogle.links.filter(isSafeGoogleConfirmationUrl);

  const linksHtml =
    safeLinks.length > 0
      ? safeLinks
          .map((link) => {
            const safeHref = escapeHtml(link);
            return `<p><a href="${safeHref}" target="_blank" rel="noopener noreferrer" style="font-size:18px;color:#2563eb;font-weight:bold;">CLIQUE AQUI PARA CONFIRMAR O ENCAMINHAMENTO NO GOOGLE</a><br><small>${safeHref}</small></p>`;
          })
          .join('')
      : '<p style="color:#d97706;">Nenhum link direto isolado ainda.</p>';

  const recebidoEmSeguro = escapeHtml(ultimaConfirmacaoGoogle.recebidoEm || 'Aguardando...');

  return res.status(200).type('html').send(`
    <html>
      <head><meta charset="utf-8"><title>Confirmação Gmail</title></head>
      <body style="font-family:sans-serif;padding:24px;max-width:900px;margin:0 auto;background:#f9fafb;">
        <h2>Dados do Último E-mail de Confirmação do Gmail</h2>
        <p><strong>Recebido em:</strong> ${recebidoEmSeguro}</p>
        <hr/>
        <h3>Link de Confirmação:</h3>
        ${linksHtml}
      </body>
    </html>
  `);
});

// Endpoint GET para buscar o código de verificação por destinatário
router.get('/get-latest-email', requireWebhookAuth, (req, res) => {
  const correlationId = getCorrelationId(req);

  try {
    res.setHeader('Cache-Control', 'no-store');

    const { to } = req.query;
    if (typeof to !== 'string' || to.trim().length === 0) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Parâmetro "to" é obrigatório.' },
      });
    }

    const emailBusca = to.toLowerCase().trim();
    if (emailBusca.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailBusca)) {
      return res.status(400).json({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Parâmetro "to" inválido.' },
      });
    }

    pruneVerificationStore();
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
    logger.error('Erro interno ao buscar código de verificação.', {
      category: 'WEBHOOK_LOOKUP_ERROR',
      correlationId,
      errorName: err?.name || 'Error',
      errorCode: err?.code || null,
    });
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Erro interno ao buscar o código.' },
    });
  }
});

module.exports = router;