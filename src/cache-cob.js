'use strict';

/**
 * Cache de status da cobrança por txid, SEPARADO POR AMBIENTE.
 *   cache/{ambiente}/{txid}.json  ->  { status, copia_cola, atualizado_em, ... }
 *
 * Alimentado pelo worker (ao concluir -> CONCLUIDA) e pelas consultas ao BB.
 * Quando o status é CONCLUIDA, a consulta pode responder do cache sem ir ao BB.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'cache');

const AMBIENTES = ['sandbox', 'producao'];

function ambienteValido(amb) {
  return AMBIENTES.includes(amb) ? amb : 'sandbox';
}

function txidSeguro(txid) {
  return String(txid == null ? '' : txid).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

function caminho(ambiente, txid) {
  return path.join(BASE, ambienteValido(ambiente), `${txidSeguro(txid)}.json`);
}

function garantirDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Grava/atualiza o cache do txid. Faz merge com o que já existir.
 * @returns o registro gravado.
 */
function gravar(ambiente, txid, dados = {}) {
  const t = txidSeguro(txid);
  if (!t) return null;
  const arq = caminho(ambiente, t);
  garantirDir(path.dirname(arq));

  let atual = {};
  try { atual = JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (_) { atual = {}; }

  const registro = {
    ...atual,
    ...dados,
    txid: t,
    ambiente: ambienteValido(ambiente),
    atualizado_em: new Date().toISOString(),
  };
  fs.writeFileSync(arq, JSON.stringify(registro, null, 2), 'utf8');
  return registro;
}

/** Lê o cache do txid (ou null se não existir). */
function ler(ambiente, txid) {
  const arq = caminho(ambiente, txid);
  if (!fs.existsSync(arq)) return null;
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch (_) { return null; }
}

/** true se o cache marca CONCLUIDA. */
function estaConcluida(ambiente, txid) {
  const c = ler(ambiente, txid);
  return !!(c && String(c.status).toUpperCase() === 'CONCLUIDA');
}

/** Atalho: marca CONCLUIDA (usado pelo worker). */
function marcarConcluida(ambiente, txid, extra = {}) {
  return gravar(ambiente, txid, { status: 'CONCLUIDA', ...extra });
}

module.exports = { gravar, ler, estaConcluida, marcarConcluida, BASE, AMBIENTES };
