'use strict';

/**
 * Camada de fila (RabbitMQ via amqplib).
 *
 * Filas por ambiente (TUDO separado, nada misturado):
 *   pix.webhook.{amb}              -> fila principal (durable)
 *   pix.webhook.{amb}.dlq          -> dead-letter (dado inválido / poison)
 *   pix.webhook.{amb}.reprocessar  -> banco fora / txid ainda inexistente
 *
 * amqplib NÃO reconecta sozinho: aqui há um gerenciador de conexão com
 * backoff + RE-ASSERT das filas a cada (re)conexão. Publicação é persistente
 * (deliveryMode 2) em fila durável.
 */

const amqp = require('amqplib');

const AMBIENTES = ['sandbox', 'producao'];

function url() {
  return process.env.RABBITMQ_URL || 'amqp://guest:guest@rabbitmq:5672';
}

// ---- nomes de fila ---------------------------------------------------------
function nomeFila(amb) { return `pix.webhook.${amb}`; }
function nomeDlq(amb) { return `pix.webhook.${amb}.dlq`; }
function nomeReprocessar(amb) { return `pix.webhook.${amb}.reprocessar`; }

/** Declara (idempotente) todas as filas de um ambiente num canal. */
async function assertAmbiente(ch, amb) {
  await ch.assertQueue(nomeFila(amb), { durable: true });
  await ch.assertQueue(nomeDlq(amb), { durable: true });
  await ch.assertQueue(nomeReprocessar(amb), { durable: true });
}

/** Declara as filas de TODOS os ambientes. */
async function assertTodas(ch) {
  for (const amb of AMBIENTES) await assertAmbiente(ch, amb);
}

// ---- gerenciador de conexão com reconnect ---------------------------------
let conn = null;
let canal = null;
let conectando = null;
let fechado = false;
let tentativa = 0;
const ouvintesReconexao = []; // callbacks chamados a cada canal novo (p/ re-consumir)

/** Chama um ouvinte no canal, no MÁXIMO uma vez por canal (evita consumo duplo). */
async function chamarOuvinte(cb, ch) {
  if (!ch._ouvintesInstalados) ch._ouvintesInstalados = new Set();
  if (ch._ouvintesInstalados.has(cb)) return;
  ch._ouvintesInstalados.add(cb);
  await cb(ch);
}

function log(evento, extra = {}) {
  try {
    console.log(JSON.stringify({ ts: new Date().toISOString(), fila: evento, ...extra }));
  } catch (_) { /* ignora */ }
}

function backoffMs() {
  const base = Math.min(30000, 500 * Math.pow(2, tentativa)); // 0.5s..30s
  return base + Math.floor(Math.random() * 250); // jitter
}

/**
 * Garante conexão + canal. Re-assert das filas. Reconecta com backoff em caso
 * de erro/close. Retorna o canal atual.
 */
async function garantirCanal() {
  if (fechado) throw new Error('fila: gerenciador fechado');
  if (canal) return canal;
  if (conectando) return conectando;

  conectando = (async () => {
    for (;;) {
      if (fechado) throw new Error('fila: gerenciador fechado');
      try {
        conn = await amqp.connect(url(), { heartbeat: 15 });
        conn.on('error', (e) => log('conexao_erro', { erro: e.message }));
        conn.on('close', () => {
          if (fechado) return;
          log('conexao_fechada');
          canal = null;
          conn = null;
          agendarReconexao();
        });

        canal = await conn.createChannel();
        canal.on('error', (e) => log('canal_erro', { erro: e.message }));
        canal.on('close', () => { canal = null; });

        await assertTodas(canal);
        tentativa = 0;
        log('conectado', { url: url().replace(/:[^:@/]+@/, ':***@') });

        // re-registra consumidores (worker) no novo canal (1x por canal)
        for (const cb of ouvintesReconexao) {
          try { await chamarOuvinte(cb, canal); } catch (e) { log('reconsumo_erro', { erro: e.message }); }
        }
        return canal;
      } catch (e) {
        tentativa += 1;
        const espera = backoffMs();
        log('conexao_falhou', { erro: e.message, tentativa, proxima_ms: espera });
        await new Promise((r) => setTimeout(r, espera));
      }
    }
  })();

  try {
    return await conectando;
  } finally {
    conectando = null;
  }
}

let timerReconexao = null;
function agendarReconexao() {
  if (fechado || timerReconexao) return;
  const espera = backoffMs();
  timerReconexao = setTimeout(() => {
    timerReconexao = null;
    garantirCanal().catch((e) => log('reconexao_erro', { erro: e.message }));
  }, espera);
}

/**
 * Registra um callback (worker) chamado a cada canal novo, para re-instalar o
 * consumo após reconexão. Chama já com o canal atual se houver.
 */
async function aoReconectar(cb) {
  ouvintesReconexao.push(cb);
  const ch = await garantirCanal();
  // garantirCanal já pode ter chamado o ouvinte no loop de conexão; chamarOuvinte
  // é idempotente por canal, então não instala o consumo duas vezes.
  await chamarOuvinte(cb, ch);
}

/**
 * Publica um evento na fila indicada (default: fila principal do ambiente).
 * Mensagem PERSISTENTE em fila DURÁVEL. Usa o buffer interno do amqplib.
 * @param {string} ambiente sandbox|producao
 * @param {object} evento   objeto a publicar (JSON)
 * @param {object} [opts]   { fila: 'principal'|'dlq'|'reprocessar', headers }
 */
async function publicar(ambiente, evento, opts = {}) {
  const amb = AMBIENTES.includes(ambiente) ? ambiente : 'sandbox';
  const ch = await garantirCanal();

  let destino;
  switch (opts.fila) {
    case 'dlq': destino = nomeDlq(amb); break;
    case 'reprocessar': destino = nomeReprocessar(amb); break;
    default: destino = nomeFila(amb); break;
  }

  const buf = Buffer.from(JSON.stringify(evento));
  const ok = ch.sendToQueue(destino, buf, {
    persistent: true,
    contentType: 'application/json',
    headers: opts.headers || {},
  });
  // sendToQueue retorna false quando o buffer interno está cheio; espera drain.
  if (!ok) {
    await new Promise((r) => ch.once('drain', r));
  }
  return { fila: destino, ambiente: amb };
}

/** Canal atual (ou cria). Usado pelo worker para consumir. */
async function canalAtual() {
  return garantirCanal();
}

/** Fecha tudo (shutdown gracioso). */
async function fechar() {
  fechado = true;
  if (timerReconexao) { clearTimeout(timerReconexao); timerReconexao = null; }
  try { if (canal) await canal.close(); } catch (_) { /* ignora */ }
  try { if (conn) await conn.close(); } catch (_) { /* ignora */ }
  canal = null;
  conn = null;
}

module.exports = {
  AMBIENTES,
  nomeFila,
  nomeDlq,
  nomeReprocessar,
  assertAmbiente,
  assertTodas,
  garantirCanal,
  canalAtual,
  aoReconectar,
  publicar,
  fechar,
};
