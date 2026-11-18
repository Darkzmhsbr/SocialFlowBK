const { Router } = require('express');
const logger = require('../utils/logger');

const router = Router();

// Armazenamento em memória temporário para os códigos de verificação por e-mail
const verificationStore = new Map();

// Armazena a última confirmação do Google para visualização no navegador
let ultimaConfirmacaoGoogle = {
  recebidoEm: null,
  links: [],
  codigos: [],
  textoDecodificado: 'Nenhum e-mail de confirmação do Google recebido ainda após este deploy.',
};

// Função auxiliar para extrair o corpo real do e-mail sem os cabeçalhos técnicos da Cloudflare/Google
function extrairEDecodificarCorpo(bodyData) {
  let textoCorpo = '';

  if (typeof bodyData === 'object' && bodyData !== null) {
    // Prioriza os campos limpos (subject, text, html) antes do raw bruto
    let rawSemHeaders = String(bodyData.raw || '');
    // Em um e-mail MIME raw, o corpo real sempre começa após a primeira linha em branco dupla (\r\n\r\n)
    const divisorHeaderCorpo = rawSemHeaders.indexOf('\r\n\r\n');
    if (divisorHeaderCorpo !== -1) {
      rawSemHeaders = rawSemHeaders.substring(divisorHeaderCorpo);
    }

    textoCorpo = [
      bodyData.subject ? `Subject: ${bodyData.subject}` : '',
      bodyData.text || '',
      bodyData.html || '',
      rawSemHeaders,
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    textoCorpo = String(bodyData || '');
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
    } catch (e) {
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
  const matchPortugues = fonteCompleta.match(/\b(\d{6})\s+(?:é|e)\s+o\s+seu\s+c[oó]digo\s+do\s+Instagram/i);
  if (matchPortugues) return matchPortugues[1];

  // 3. Padrão na linha de Subject do cabeçalho MIME: "Subject: 274559 is your..."
  const matchSubjectHeader = fonteCompleta.match(/Subject:\s*(\d{6})\b/i);
  if (matchSubjectHeader) return matchSubjectHeader[1];

  // 4. Se o objeto tiver a propriedade subject explícita
  if (typeof bodyData === 'object' && bodyData?.subject) {
    const matchObjSubject = String(bodyData.subject).match(/\b(\d{6})\b/);
    if (matchObjSubject) return matchObjSubject[1];
  }

  // 5. Padrão no HTML do Instagram (código isolado após frases como "confirm your email" ou dentro de tags grandes)
  const matchContextoIg = textoLimpo.match(
    /(?:Instagram\s+code|c[oó]digo\s+do\s+Instagram|confirm\s+your\s+email|confirme\s+seu\s+email)[\s\S]{0,120}?\b(\d{6})\b/i
  );
  if (matchContextoIg && matchContextoIg[1] !== '260707') return matchContextoIg[1];

  // 6. Fallback seguro: procura 6 dígitos no corpo ignorando falsos positivos conhecidos de headers do Google/Cloudflare
  const falsosPositivos = new Set(['260707', '202607', '202603', '000000', '111111']);
  const todosSeisDigitos = textoLimpo.match(/\b\d{6}\b/g) || [];
  for (const candidato of todosSeisDigitos) {
    if (!falsosPositivos.has(candidato)) {
      return candidato;
    }
  }

  return null;
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
      rawString.includes('forwarding-noreply')
    ) {
      const linksGoogle =
        textoLimpoEDecodificado.match(
          /https:\/\/(?:mail-settings|mail|isolated)\.google\.com\/[^\s"\\<>')]+/g
        ) || [];

      const finalDoEmail = textoLimpoEDecodificado.slice(-3500);

      ultimaConfirmacaoGoogle = {
        recebidoEm: new Date().toISOString(),
        links: [...new Set(linksGoogle)],
        codigos: [],
        textoDecodificado: finalDoEmail,
      };

      logger.info('=== CONFIRMAÇÃO DO GMAIL DECODIFICADA COM SUCESSO ===', {
        linksEncontrados: ultimaConfirmacaoGoogle.links,
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

    if (code) {
      const now = new Date();

      for (const chave of destinatariosUnicos) {
        verificationStore.set(chave, {
          code,
          receivedAt: now,
        });
      }

      verificationStore.set('ultimo_codigo_geral', {
        code,
        receivedAt: now,
      });

      logger.info('Código REAL do Instagram extraído e armazenado com sucesso!', {
        code,
        aliasCapturado: destinatariosUnicos.filter((e) => e.includes('+')),
      });
    } else {
      logger.warn('Não foi possível extrair o código de 6 dígitos do Instagram.', {
        content: textoLimpoEDecodificado.slice(-1000),
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

// Rota visual de apoio para confirmação de encaminhamento do Google
router.get('/confirmacao-google', (req, res) => {
  const linksHtml =
    ultimaConfirmacaoGoogle.links.length > 0
      ? ultimaConfirmacaoGoogle.links
          .map(
            (l) =>
              `<p><a href="${l}" target="_blank" style="font-size:18px;color:#2563eb;font-weight:bold;">CLIQUE AQUI PARA CONFIRMAR O ENCAMINHAMENTO NO GOOGLE</a><br><small>${l}</small></p>`
          )
          .join('')
      : '<p style="color:#d97706;">Nenhum link direto isolado ainda.</p>';

  res.status(200).send(`
    <html>
      <head><meta charset="utf-8"><title>Confirmação Gmail</title></head>
      <body style="font-family:sans-serif;padding:24px;max-width:900px;margin:0 auto;background:#f9fafb;">
        <h2>Dados do Último E-mail de Confirmação do Gmail</h2>
        <p><strong>Recebido em:</strong> ${ultimaConfirmacaoGoogle.recebidoEm || 'Aguardando...'}</p>
        <hr/>
        <h3>Link de Confirmação:</h3>
        ${linksHtml}
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