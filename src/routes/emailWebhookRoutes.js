const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();

// Armazenamento em memória temporário para os códigos de verificação por e-mail
const verificationStore = new Map();

// Armazena a última confirmação do Google para você abrir direto no navegador se quiser
let ultimaConfirmacaoGoogle = {
  recebidoEm: null,
  links: [],
  codigos: [],
  textoDecodificado: 'Nenhum e-mail de confirmação do Google recebido ainda após este deploy.',
};

// Função auxiliar para remover os 'headers' gigantes e decodificar Base64 / Quoted-Printable do corpo do e-mail
function extrairEDecodificarCorpo(bodyData) {
  let textoTotal = '';

  if (typeof bodyData === 'object' && bodyData !== null) {
    // Cria uma cópia sem o array gigante de 'headers' que polui os primeiros 5000 caracteres
    const copiaSemHeaders = { ...bodyData };
    delete copiaSemHeaders.headers;
    textoTotal = [
      bodyData.text,
      bodyData.html,
      bodyData.raw,
      bodyData.subject,
      JSON.stringify(copiaSemHeaders),
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    textoTotal = String(bodyData || '');
  }

  // 1. Limpa quebras de linha Quoted-Printable (ex: "=\r\n" ou "=\n" e "=3D")
  const textoSemQP = textoTotal
    .replace(/=\r?\n/g, '')
    .replace(/=3D/gi, '=')
    .replace(/=20/g, ' ');

  let blocosDecodificados = '';

  // 2. Procura blocos codificados em Base64 dentro do MIME raw e decodifica para UTF-8
  const possiveisBlocosBase64 = textoTotal.match(/(?:[A-Za-z0-9+/]{40,}(?:\r?\n|\\r\\n|\\n)?){2,}/g) || [];
  for (const bloco of possiveisBlocosBase64) {
    try {
      const limpo = bloco.replace(/\\r|\\n|\s+/g, '');
      const decodificado = Buffer.from(limpo, 'base64').toString('utf-8');
      // Só adiciona se o resultado parecer texto legível
      if (decodificado.includes('http') || decodificado.includes('google') || decodificado.includes(' ')) {
        blocosDecodificados += '\n' + decodificado;
      }
    } catch (e) {
      // Ignora blocos que não são base64 válido
    }
  }

  return `${textoSemQP}\n${blocosDecodificados}`;
}

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

    const bodyData = req.body;
    const rawString = typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData);
    const textoLimpoEDecodificado = extrairEDecodificarCorpo(bodyData);

    logger.info('E-mail interceptado recebido com sucesso. Analisando conteúdo...');

    // 1. TRATAMENTO ESPECIAL: E-mail de confirmação de encaminhamento do Google/Gmail
    if (
      rawString.includes('forwarding-noreply@google.com') ||
      textoLimpoEDecodificado.includes('mail-settings.google.com') ||
      textoLimpoEDecodificado.includes(' isolate') ||
      rawString.includes('forwarding-noreply')
    ) {
      const linksGoogle =
        textoLimpoEDecodificado.match(/https:\/\/(?:mail-settings|mail|isolated)\.google\.com\/[^\s"\\<>')]+/g) ||
        textoLimpoEDecodificado.match(/https:\/\/[^\s"\\<>')]*google\.com\/mail\/[^\s"\\<>')]+/g) ||
        [];

      const codigosMatch =
        textoLimpoEDecodificado.match(/(?:c[oó]digo|code|confirma[cç][aã]o)[^\d]{1,35}(\d{6,10})/gi) ||
        textoLimpoEDecodificado.match(/\b\d{8,10}\b/g) ||
        [];

      // Pega apenas a parte final do e-mail (onde fica o corpo da mensagem, depois dos headers)
      const finalDoEmail = textoLimpoEDecodificado.slice(-3500);

      ultimaConfirmacaoGoogle = {
        recebidoEm: new Date().toISOString(),
        links: [...new Set(linksGoogle)],
        codigos: [...new Set(codigosMatch)],
        textoDecodificado: finalDoEmail,
      };

      logger.info('=== CONFIRMAÇÃO DO GMAIL DECODIFICADA COM SUCESSO ===', {
        linksEncontrados: ultimaConfirmacaoGoogle.links,
        codigosEncontrados: ultimaConfirmacaoGoogle.codigos,
        corpoFinalDoEmail: finalDoEmail,
      });

      return res.status(200).json({
        success: true,
        message: 'E-mail de confirmação do Google decodificado!',
      });
    }

    // 2. EXTRAÇÃO DO CÓDIGO DE 6 DÍGITOS DO INSTAGRAM
    let code = null;
    const subjectText =
      typeof bodyData === 'object' && bodyData?.subject ? String(bodyData.subject) : '';

    // Prioridade 1: Código no assunto do e-mail (ex: "123456 is your Instagram code")
    const subjectMatch = subjectText.match(/\b(\d{6})\b/);
    // Prioridade 2: Código próximo a palavras-chave do Instagram no texto decodificado
    const contextMatch = textoLimpoEDecodificado.match(
      /(?:Instagram|c[oó]digo|code|confirm)[^\d]{0,40}\b(\d{6})\b/i
    );

    if (subjectMatch) {
      code = subjectMatch[1];
    } else if (contextMatch) {
      code = contextMatch[1];
    } else {
      const matches = textoLimpoEDecodificado.match(/\b\d{6}\b/g);
      if (matches && matches.length > 0) {
        code = matches[0];
      }
    }

    // Identifica todos os e-mails presentes (suporta '+' para Gmail Alias e domínios próprios)
    const emailMatches = textoLimpoEDecodificado.match(/[\w.+-]+@[\w.-]+\.\w+/g) || [];

    if (code) {
      const now = new Date();

      for (const emailEncontrado of emailMatches) {
        const chave = emailEncontrado.toLowerCase().trim();
        verificationStore.set(chave, {
          code,
          receivedAt: now,
        });
      }

      verificationStore.set('ultimo_codigo_geral', {
        code,
        receivedAt: now,
      });

      logger.info('Código de verificação extraído e armazenado com sucesso', {
        code,
        destinatariosVinculados: emailMatches,
      });
    } else {
      logger.warn('Não foi possível extrair o código de 6 dígitos do e-mail. Final do conteúdo:', {
        content: textoLimpoEDecodificado.slice(-1500),
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

// ROTA VISUAL PARA VOCÊ PEGAR O LINK DO GOOGLE DIRETO NO NAVEGADOR SEM SOFRER NO LOG DO RAILWAY
router.get('/confirmacao-google', (req, res) => {
  const linksHtml =
    ultimaConfirmacaoGoogle.links.length > 0
      ? ultimaConfirmacaoGoogle.links
          .map((l) => `<p><a href="${l}" target="_blank" style="font-size:18px;color:#2563eb;font-weight:bold;">CLIQUE AQUI PARA CONFIRMAR O ENCAMINHAMENTO NO GOOGLE</a><br><small>${l}</small></p>`)
          .join('')
      : '<p style="color:#d97706;">Nenhum link direto isolado ainda — veja o texto completo do corpo do e-mail abaixo.</p>';

  res.status(200).send(`
    <html>
      <head><meta charset="utf-8"><title>Confirmação Gmail</title></head>
      <body style="font-family:sans-serif;padding:24px;max-width:900px;margin:0 auto;background:#f9fafb;">
        <h2>Dados do Último E-mail de Confirmação do Gmail</h2>
        <p><strong>Recebido em:</strong> ${ultimaConfirmacaoGoogle.recebidoEm || 'Aguardando reenvio...'}</p>
        <p><strong>Possíveis códigos numéricos:</strong> ${ultimaConfirmacaoGoogle.codigos.join(' | ') || 'Verifique no texto abaixo'}</p>
        <hr/>
        <h3>Link de Confirmação:</h3>
        ${linksHtml}
        <hr/>
        <h3>Corpo Final do E-mail (Sem os Headers da Cloudflare):</h3>
        <pre style="background:#1f2937;color:#f3f4f6;padding:16px;border-radius:8px;white-space:pre-wrap;word-break:break-all;">${ultimaConfirmacaoGoogle.textoDecodificado.replace(/</g, '&lt;')}</pre>
      </body>
    </html>
  `);
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