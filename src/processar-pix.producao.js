'use strict';

/**
 * Lógica de PIX recebido em PRODUÇÃO — DINHEIRO REAL. Cuidado aqui.
 * Recebe UM pix de cada vez.
 *
 * @param {object} cfg   config da empresa/ambiente (cfg.slug, cfg.ambiente)
 * @param {object} pix   um item do array corpo.pix (txid, valor, endToEndId, pagador...)
 * @param {object} corpo body completo do webhook
 */
async function processar(cfg, pix, corpo) {
  console.log(`[PROD] PIX real: txid=${pix.txid} valor=${pix.valor} pagador=${pix.pagador && pix.pagador.nome}`);

  // >>> SUA REGRA DE PRODUÇÃO AQUI <<<
  // ex.: dar baixa no txid, marcar a vaga/pedido como pago, chamar seu sistema:
  //
  // await fetch('https://SEU-SISTEMA/api/pix-recebido', {
  //   method: 'POST',
  //   headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ...' },
  //   body: JSON.stringify({
  //     empresa: cfg.slug, txid: pix.txid, valor: pix.valor,
  //     endToEndId: pix.endToEndId, pagador: pix.pagador,
  //   }),
  // });
}

module.exports = { processar };
