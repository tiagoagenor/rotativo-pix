'use strict';

/**
 * >>> COLOQUE SUA LÓGICA DE NEGÓCIO AQUI <<<
 *
 * Chamado pelo webhook (index.js -> tratarWebhook) DEPOIS de validar token/IP,
 * toda vez que o BB avisa que um PIX foi recebido.
 *
 * @param {object} cfg   config da empresa/ambiente já resolvida.
 *                        Útil: cfg.slug (empresa), cfg.ambiente (sandbox|producao).
 * @param {object} corpo body enviado pelo BB. Formato típico:
 *   {
 *     "pix": [
 *       {
 *         "endToEndId": "E60746948202103082223A7540Db1234",
 *         "txid":       "123234443",
 *         "valor":      "100.00",
 *         "chave":      "sua-chave-pix",
 *         "horario":    "2026-08-02T14:30:47.00-03:00",
 *         "infoPagador":"Pedido XYZ",
 *         "pagador":    { "cpf": "93492239293", "nome": "VICTOR LOPES DORNELES" }
 *       }
 *     ]
 *   }
 *
 * IMPORTANTE: isto roda em segundo plano — o webhook já respondeu 200 pro BB.
 * Se algo aqui falhar, o erro é logado (não derruba a resposta ao BB).
 */
async function processarPix(cfg, corpo) {
  const lista = (corpo && Array.isArray(corpo.pix)) ? corpo.pix : [];

  for (const pix of lista) {
    const { txid, endToEndId, valor, pagador } = pix;

    // ---------------------------------------------------------------------
    // EXEMPLO — troque pela sua regra (dar baixa, marcar vaga paga, chamar
    // seu sistema/Laravel, gravar no banco, mandar mensagem, etc.)
    // ---------------------------------------------------------------------
    console.log(
      `[PIX ${cfg.slug}/${cfg.ambiente}] recebido: txid=${txid} valor=${valor} ` +
      `pagador=${pagador && pagador.nome} e2e=${endToEndId}`
    );

    // Ex.: await fetch('https://seu-sistema/api/pix-pago', {
    //   method: 'POST',
    //   headers: { 'Content-Type': 'application/json' },
    //   body: JSON.stringify({ empresa: cfg.slug, ambiente: cfg.ambiente, txid, valor, pagador })
    // });
  }
}

module.exports = { processarPix };
