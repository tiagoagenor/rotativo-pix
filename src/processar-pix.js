'use strict';

/**
 * Roteador do processamento de PIX recebido no webhook.
 * Escolhe a lógica conforme o AMBIENTE e chama uma vez por PIX recebido.
 *
 *   sandbox  -> src/processar-pix.sandbox.js   (testes)
 *   producao -> src/processar-pix.producao.js  (dinheiro real)
 *
 * Coloque SUA regra dentro do arquivo do ambiente correspondente.
 * Chamado pelo index.js (tratarWebhook) em 2º plano — não segura o 200 pro BB.
 */
const handlers = {
  sandbox: require('./processar-pix.sandbox'),
  producao: require('./processar-pix.producao'),
};

async function processarPix(cfg, corpo) {
  const handler = handlers[cfg.ambiente];
  if (!handler) {
    console.warn(`[PIX] sem handler para ambiente "${cfg.ambiente}"`);
    return;
  }
  const lista = (corpo && Array.isArray(corpo.pix)) ? corpo.pix : [];
  for (const pix of lista) {
    await handler.processar(cfg, pix, corpo);
  }
}

module.exports = { processarPix };
