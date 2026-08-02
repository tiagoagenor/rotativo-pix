'use strict';

/**
 * Worker do rotativo-pix.
 *
 * Consome pix.webhook.sandbox e pix.webhook.producao (ACK MANUAL, prefetch
 * configurável) e, para cada PIX do payload, confirma a transação replicando o
 * PixPaymentStrategy::confirm() (ver src/confirmar-pix.js): marca a transação
 * como concluída e credita a carteira (depósito) de forma idempotente.
 *
 * Matriz de erro (decisão do destino da MENSAGEM):
 *   - transitório (MySQL fora / deadlock / lock timeout): 3x backoff -> .reprocessar (ack)
 *   - txid ainda inexistente (webhook antes da geração): requeue com limite -> .reprocessar
 *   - dado inválido (sem txid): -> .dlq (ack)
 *   - já concluída / movimento duplicado: -> ack (idempotente)
 *
 * Shutdown gracioso: para de consumir, termina in-flight, fecha conexões.
 */

require('dotenv').config();

const db = require('./src/db');
const fila = require('./src/fila');
const confirmar = require('./src/confirmar-pix');

const AMBIENTES = ['sandbox', 'producao'];

const PREFETCH = Number(process.env.WORKER_PREFETCH) || 10;
const RETRY_TRANSIENT = Number(process.env.WORKER_RETRY_TRANSIENT) || 3;
const RETRY_BACKOFF_MS = Number(process.env.WORKER_RETRY_BACKOFF_MS) || 500;
const MAX_TENTATIVAS_GERACAO = Number(process.env.WORKER_MAX_TENTATIVAS_GERACAO) || 5;
const REQUEUE_DELAY_MS = Number(process.env.WORKER_REQUEUE_DELAY_MS) || 3000;

let emInflight = 0;
let encerrando = false;

function log(evento, extra = {}) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), worker: evento, ...extra })); }
  catch (_) { /* ignora */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// Handler de uma mensagem da fila
// ---------------------------------------------------------------------------
async function tratarMensagem(ch, ambiente, msg) {
  emInflight += 1;
  let evento = null;
  try {
    try {
      evento = JSON.parse(msg.content.toString());
    } catch (_) {
      log('mensagem_json_invalido', { ambiente });
      await fila.publicar(ambiente, { erro: 'json_invalido', bruto: msg.content.toString().slice(0, 500) }, { fila: 'dlq' });
      ch.ack(msg);
      return;
    }

    const empresaId = evento.empresa_id != null ? evento.empresa_id : (evento.corpo && evento.corpo.empresa_id);
    const corpo = evento.corpo || evento;
    const lista = corpo && Array.isArray(corpo.pix) ? corpo.pix : [];

    if (lista.length === 0) {
      log('evento_sem_pix', { ambiente, arquivo: evento.arquivo });
      await fila.publicar(ambiente, evento, { fila: 'dlq' });
      ch.ack(msg);
      return;
    }

    const resultados = [];
    let transitorio = false;

    for (const pix of lista) {
      try {
        resultados.push(await confirmar.confirmarUmPixComRetry(ambiente, empresaId, pix, {
          retries: RETRY_TRANSIENT,
          backoffMs: RETRY_BACKOFF_MS,
          log,
        }));
      } catch (e) {
        transitorio = true;
        log('pix_transitorio', { ambiente, txid: pix && pix.txid, erro: e.message });
      }
    }

    // ---- decide o destino da mensagem ----
    if (transitorio) {
      await fila.publicar(ambiente, evento, { fila: 'reprocessar', headers: { motivo: 'transitorio' } });
      log('mensagem_para_reprocessar', { ambiente, motivo: 'transitorio' });
      ch.ack(msg);
      return;
    }

    if (resultados.includes('notfound')) {
      const tentativas = (msg.properties.headers && Number(msg.properties.headers['x-tentativas-geracao'])) || 0;
      if (tentativas + 1 >= MAX_TENTATIVAS_GERACAO) {
        await fila.publicar(ambiente, evento, { fila: 'reprocessar', headers: { motivo: 'txid_inexistente', tentativas: tentativas + 1 } });
        log('mensagem_para_reprocessar', { ambiente, motivo: 'txid_inexistente', tentativas: tentativas + 1 });
        ch.ack(msg);
      } else {
        // requeue com atraso (evita busy-loop): republica na fila principal.
        const headers = { ...(msg.properties.headers || {}), 'x-tentativas-geracao': tentativas + 1 };
        setTimeout(() => {
          fila.publicar(ambiente, evento, { headers })
            .catch((e) => log('requeue_erro', { ambiente, erro: e.message }));
        }, REQUEUE_DELAY_MS);
        log('mensagem_requeue', { ambiente, motivo: 'txid_inexistente', tentativa: tentativas + 1 });
        ch.ack(msg);
      }
      return;
    }

    if (resultados.length > 0 && resultados.every((r) => r === 'invalido')) {
      await fila.publicar(ambiente, evento, { fila: 'dlq', headers: { motivo: 'invalido' } });
      log('mensagem_para_dlq', { ambiente, motivo: 'invalido' });
      ch.ack(msg);
      return;
    }

    // ok (possivelmente com algum inválido misturado -> já logado)
    ch.ack(msg);
  } catch (e) {
    // Erro inesperado no próprio handler: não perde a mensagem -> reprocessar.
    log('handler_erro', { ambiente, erro: e.message });
    try {
      await fila.publicar(ambiente, evento || { bruto: msg.content.toString().slice(0, 500) }, { fila: 'reprocessar', headers: { motivo: 'handler_erro' } });
      ch.ack(msg);
    } catch (e2) {
      try { ch.nack(msg, false, true); } catch (_) { /* ignora */ }
    }
  } finally {
    emInflight -= 1;
  }
}

// ---------------------------------------------------------------------------
// Instala o consumo (re-chamado a cada reconexão via fila.aoReconectar)
// ---------------------------------------------------------------------------
const consumerTags = {}; // ambiente -> consumerTag

async function instalarConsumo(ch) {
  await ch.prefetch(PREFETCH);
  for (const ambiente of AMBIENTES) {
    const q = fila.nomeFila(ambiente);
    const { consumerTag } = await ch.consume(q, (msg) => {
      if (msg === null) return; // consumidor cancelado
      if (encerrando) return;
      tratarMensagem(ch, ambiente, msg);
    }, { noAck: false });
    consumerTags[ambiente] = consumerTag;
    log('consumindo', { fila: q, prefetch: PREFETCH });
  }
}

// ---------------------------------------------------------------------------
// Shutdown gracioso
// ---------------------------------------------------------------------------
async function encerrar(sinal) {
  if (encerrando) return;
  encerrando = true;
  log('encerrando', { sinal, inflight: emInflight });
  try {
    const ch = await fila.canalAtual().catch(() => null);
    if (ch) {
      for (const [amb, tag] of Object.entries(consumerTags)) {
        try { await ch.cancel(tag); log('consumo_cancelado', { ambiente: amb }); } catch (_) { /* ignora */ }
      }
    }
  } catch (_) { /* ignora */ }

  const limite = Date.now() + 25000;
  while (emInflight > 0 && Date.now() < limite) {
    await sleep(100);
  }

  try { await fila.fechar(); } catch (_) { /* ignora */ }
  try { await db.fecharTudo(); } catch (_) { /* ignora */ }
  log('encerrado', { inflight_restante: emInflight });
  process.exit(0);
}

process.on('SIGTERM', () => encerrar('SIGTERM'));
process.on('SIGINT', () => encerrar('SIGINT'));

// ---------------------------------------------------------------------------
async function main() {
  log('iniciando', { prefetch: PREFETCH, db_por_ambiente: db.porAmbiente(), ambientes: AMBIENTES });
  await fila.aoReconectar(instalarConsumo);
  log('pronto');
}

main().catch((e) => {
  log('fatal', { erro: e.message, stack: e.stack });
  process.exit(1);
});
