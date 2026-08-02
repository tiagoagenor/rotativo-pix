'use strict';

/**
 * Lógica de PIX recebido em SANDBOX (homologação) — só testes, sem dinheiro real.
 * Recebe UM pix de cada vez. Use pra validar o fluxo sem afetar produção.
 *
 * @param {object} cfg   config da empresa/ambiente (cfg.slug, cfg.ambiente)
 * @param {object} pix   um item do array corpo.pix (txid, valor, endToEndId, pagador...)
 * @param {object} corpo body completo do webhook (se precisar de algo além do pix)
 */
async function processar(cfg, pix, corpo) {
  console.log(`[SANDBOX] PIX teste: txid=${pix.txid} valor=${pix.valor} pagador=${pix.pagador && pix.pagador.nome}`);

  // >>> SUA REGRA DE TESTE AQUI <<<
  // ex.: só logar, ou apontar pra um endpoint de homologação do seu sistema.
}

module.exports = { processar };
