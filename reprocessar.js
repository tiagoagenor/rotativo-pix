'use strict';

/**
 * Comando MANUAL de reprocessamento.
 *
 * Drena a fila pix.webhook.{amb}.reprocessar e reprocessa cada evento (mesma
 * lógica idempotente do worker). Rodar quando o banco voltar / após corrigir a
 * causa que mandou as mensagens pra .reprocessar.
 *
 * Uso:
 *   node reprocessar.js sandbox
 *   node reprocessar.js producao
 *   node reprocessar.js            # ambos os ambientes
 *
 * Se um evento continuar transitório (banco ainda fora), a mensagem é DEVOLVIDA
 * à .reprocessar (não se perde). Se txid ainda não existir, também volta.
 */

require('dotenv').config();

const db = require('./src/db');
const fila = require('./src/fila');
const confirmar = require('./src/confirmar-pix');

const AMBIENTES = ['sandbox', 'producao'];

const RETRY_TRANSIENT = Number(process.env.WORKER_RETRY_TRANSIENT) || 3;
const RETRY_BACKOFF_MS = Number(process.env.WORKER_RETRY_BACKOFF_MS) || 500;
const OCIOSO_MS = Number(process.env.REPROCESSAR_OCIOSO_MS) || 2000; // sem msg por N ms -> encerra

function log(evento, extra = {}) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), reprocessar: evento, ...extra })); }
  catch (_) { /* ignora */ }
}

/**
 * Processa um evento (mesma decisão do worker, mas devolve à .reprocessar em
 * vez de re-enfileirar na principal, mantendo o comando idempotente e seguro).
 */
async function processarEvento(ambiente, evento) {
  const empresaId = evento.empresa_id != null ? evento.empresa_id : (evento.corpo && evento.corpo.empresa_id);
  const corpo = evento.corpo || evento;
  const lista = corpo && Array.isArray(corpo.pix) ? corpo.pix : [];
  if (lista.length === 0) return 'vazio';

  const resultados = [];
  let transitorio = false;
  for (const pix of lista) {
    try {
      resultados.push(await confirmar.confirmarUmPixComRetry(ambiente, empresaId, pix, {
        retries: RETRY_TRANSIENT, backoffMs: RETRY_BACKOFF_MS, log,
      }));
    } catch (e) {
      transitorio = true;
      log('pix_transitorio', { ambiente, txid: pix && pix.txid, erro: e.message });
    }
  }
  if (transitorio) return 'transitorio';
  if (resultados.includes('notfound')) return 'notfound';
  if (resultados.length > 0 && resultados.every((r) => r === 'invalido')) return 'invalido';
  return 'ok';
}

async function drenarAmbiente(ch, ambiente) {
  const q = fila.nomeReprocessar(ambiente);
  let processados = 0, ok = 0, devolvidos = 0, dlq = 0;

  for (;;) {
    const msg = await ch.get(q, { noAck: false });
    if (msg === false) break; // fila vazia
    processados += 1;
    let evento = null;
    try {
      evento = JSON.parse(msg.content.toString());
    } catch (_) {
      await fila.publicar(ambiente, { erro: 'json_invalido' }, { fila: 'dlq' });
      ch.ack(msg);
      dlq += 1;
      continue;
    }

    let destino;
    try {
      destino = await processarEvento(ambiente, evento);
    } catch (e) {
      destino = 'transitorio';
      log('evento_erro', { ambiente, erro: e.message });
    }

    if (destino === 'ok' || destino === 'vazio') {
      ch.ack(msg);
      ok += 1;
    } else if (destino === 'invalido') {
      await fila.publicar(ambiente, evento, { fila: 'dlq', headers: { motivo: 'invalido' } });
      ch.ack(msg);
      dlq += 1;
    } else {
      // transitorio ou notfound: devolve à .reprocessar (não perde)
      await fila.publicar(ambiente, evento, { fila: 'reprocessar', headers: { motivo: destino } });
      ch.ack(msg);
      devolvidos += 1;
    }
  }

  log('ambiente_drenado', { ambiente, processados, ok, devolvidos, dlq });
  return { processados, ok, devolvidos, dlq };
}

async function main() {
  const arg = process.argv[2];
  const alvos = arg ? [arg] : AMBIENTES;
  for (const a of alvos) {
    if (!AMBIENTES.includes(a)) {
      console.error(`Ambiente inválido "${a}" (use sandbox|producao)`);
      process.exit(2);
    }
  }

  const ch = await fila.canalAtual();
  const totais = {};
  for (const ambiente of alvos) {
    totais[ambiente] = await drenarAmbiente(ch, ambiente);
  }

  log('concluido', { totais });
  await fila.fechar();
  await db.fecharTudo();
  process.exit(0);
}

// silencia timers pendentes
void OCIOSO_MS;

main().catch((e) => {
  log('fatal', { erro: e.message, stack: e.stack });
  process.exit(1);
});
