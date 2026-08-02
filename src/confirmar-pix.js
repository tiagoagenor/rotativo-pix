'use strict';

/**
 * Núcleo da confirmação de PIX — réplica FIEL do PixPaymentStrategy::confirm()
 * do backend Laravel. Usado tanto pelo worker.js quanto pelo reprocessar.js.
 *
 * Para um PIX (com txid), abre uma transação MySQL e:
 *   - UPDATE transacoes SET situacao='concluida'
 *       WHERE pix_referencia=? AND empresa_id=? AND ambiente=? AND situacao='pendente'
 *   - deposito_saldo: SELECT saldo FROM carteiras ... FOR UPDATE, atualiza saldo,
 *     INSERT movimentos_carteira (transacao_id UNIQUE -> idempotente).
 *   - pagamento de nota: UPDATE notas SET situacao='paga'.
 *   - COMMIT -> cache CONCLUIDA.
 *
 * Retorno (string): 'ok' | 'ja_concluida' | 'notfound' | 'invalido'.
 * Lança em erro transitório (banco fora / deadlock) para o chamador retentar.
 */

const db = require('./db');
const cache = require('./cache-cob');

const TIPO_DEPOSITO = 'deposito_saldo';
const MOV_CREDITO = 'credit';

const CODIGOS_TRANSITORIOS = new Set([
  'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH',
  'EAI_AGAIN', 'EAI_NONAME', // DNS temporariamente indisponível (host do banco caiu)
  'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT', 'ER_LOCK_DEADLOCK',
  'ER_LOCK_WAIT_TIMEOUT', 'ER_TOO_MANY_USER_CONNECTIONS', 'ER_CON_COUNT_ERROR',
  'ER_LOCK_TABLE_FULL', 'POOL_CLOSED', 'POOL_ENQUEUELIMIT',
]);

function ehTransitorio(err) {
  if (!err) return false;
  if (err.fatal === true) return true;
  if (err.code && CODIGOS_TRANSITORIOS.has(err.code)) return true;
  const msg = String(err.message || '');
  return /ECONNREFUSED|ETIMEDOUT|ECONNRESET|Connection lost|closed state|Pool is closed|Deadlock|Lock wait timeout/i.test(msg);
}

function ehDuplicado(err) {
  return err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062);
}

function logPadrao(evento, extra) {
  try { console.log(JSON.stringify({ ts: new Date().toISOString(), confirmar: evento, ...extra })); }
  catch (_) { /* ignora */ }
}

/**
 * Confirma UM pix. `log` é injetável (worker/reprocessar passam o seu).
 */
async function confirmarUmPix(ambiente, empresaId, pix, log = logPadrao) {
  const txid = pix && pix.txid ? String(pix.txid) : null;
  if (!txid || !/^[A-Za-z0-9]{1,60}$/.test(txid)) {
    log('pix_invalido', { ambiente, motivo: 'sem_txid', pix });
    return 'invalido';
  }
  if (empresaId == null) {
    log('pix_invalido', { ambiente, txid, motivo: 'sem_empresa_id' });
    return 'invalido';
  }

  const conn = await db.conexao(ambiente);
  try {
    await conn.beginTransaction();

    const [linhas] = await conn.query(
      `SELECT id, tipo, usuario_id, nota_id, valor, situacao
         FROM transacoes
        WHERE pix_referencia = ? AND empresa_id = ? AND ambiente = ?
        LIMIT 1
        FOR UPDATE`,
      [txid, empresaId, ambiente]
    );

    if (!linhas || linhas.length === 0) {
      await conn.rollback();
      return 'notfound';
    }

    const t = linhas[0];

    if (t.situacao === 'concluida') {
      await conn.rollback();
      cache.marcarConcluida(ambiente, txid, { transacao_id: t.id, ja_processado: true });
      log('pix_ja_concluido', { ambiente, txid, transacao_id: t.id });
      return 'ja_concluida';
    }

    if (t.situacao !== 'pendente') {
      await conn.rollback();
      log('pix_situacao_nao_pendente', { ambiente, txid, transacao_id: t.id, situacao: t.situacao });
      return 'ja_concluida';
    }

    await conn.query(
      `UPDATE transacoes SET situacao = 'concluida', atualizado_em = NOW() WHERE id = ?`,
      [t.id]
    );

    if (String(t.tipo) === TIPO_DEPOSITO) {
      const [carteiras] = await conn.query(
        `SELECT id, saldo FROM carteiras WHERE usuario_id = ? AND empresa_id = ? LIMIT 1 FOR UPDATE`,
        [t.usuario_id, empresaId]
      );
      if (!carteiras || carteiras.length === 0) {
        await conn.rollback();
        log('carteira_ausente', { ambiente, txid, usuario_id: t.usuario_id, empresa_id: empresaId });
        return 'notfound'; // não perder crédito -> reprocessar
      }
      const w = carteiras[0];
      const saldoAntes = Number(w.saldo);
      const saldoDepois = Number((saldoAntes + Number(t.valor)).toFixed(2));

      await conn.query(
        `UPDATE carteiras SET saldo = ?, atualizado_em = NOW() WHERE id = ?`,
        [saldoDepois.toFixed(2), w.id]
      );

      try {
        await conn.query(
          `INSERT INTO movimentos_carteira
             (empresa_id, carteira_id, tipo, valor, saldo_antes, saldo_depois, transacao_id, descricao, criado_em, atualizado_em)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            empresaId, w.id, MOV_CREDITO, Number(t.valor).toFixed(2),
            saldoAntes.toFixed(2), saldoDepois.toFixed(2), t.id,
            `Depósito de saldo via PIX (${txid})`,
          ]
        );
      } catch (e) {
        if (ehDuplicado(e)) {
          await conn.rollback();
          cache.marcarConcluida(ambiente, txid, { transacao_id: t.id, ja_processado: true });
          log('movimento_duplicado_idempotente', { ambiente, txid, transacao_id: t.id });
          return 'ja_concluida';
        }
        throw e;
      }
    } else if (t.nota_id) {
      await conn.query(
        `UPDATE notas SET situacao = 'paga', atualizado_em = NOW() WHERE id = ? AND empresa_id = ?`,
        [t.nota_id, empresaId]
      );
    }

    await conn.commit();
    cache.marcarConcluida(ambiente, txid, { transacao_id: t.id, tipo: t.tipo });
    log('pix_concluido', { ambiente, txid, transacao_id: t.id, tipo: t.tipo });
    return 'ok';
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignora */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** Confirma UM pix com retry in-process para erros transitórios. */
async function confirmarUmPixComRetry(ambiente, empresaId, pix, opts = {}) {
  const tentativasMax = Number(opts.retries) || 3;
  const backoffMs = Number(opts.backoffMs) || 500;
  const log = opts.log || logPadrao;
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= tentativasMax; tentativa++) {
    try {
      return await confirmarUmPix(ambiente, empresaId, pix, log);
    } catch (e) {
      ultimoErro = e;
      if (!ehTransitorio(e)) {
        log('erro_nao_transitorio', { ambiente, txid: pix && pix.txid, erro: e.message, code: e.code });
      }
      const espera = backoffMs * tentativa;
      log('retry_transitorio', { ambiente, txid: pix && pix.txid, tentativa, erro: e.message, code: e.code, proxima_ms: espera });
      if (tentativa < tentativasMax) await new Promise((r) => setTimeout(r, espera));
    }
  }
  const err = new Error(`transitorio_apos_${tentativasMax}: ${ultimoErro && ultimoErro.message}`);
  err.transitorio = true;
  throw err;
}

module.exports = {
  confirmarUmPix,
  confirmarUmPixComRetry,
  ehTransitorio,
  ehDuplicado,
  TIPO_DEPOSITO,
  MOV_CREDITO,
};
