'use strict';

/**
 * Logger em arquivo (JSON por linha), um arquivo por empresa+ambiente:
 *   logs/pix-{slug}-{ambiente}.log
 * Segredos são mascarados antes de gravar.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR_LOGS = path.join(ROOT, 'logs');

/** Mascara uma string, deixando só o começo/fim visíveis. */
function mascararStr(v) {
  if (typeof v !== 'string' || v.length === 0) return v;
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}…${v.slice(-2)}`;
}

const CHAVES_SENSIVEIS = new Set([
  'authorization', 'basic', 'bearer', 'access_token', 'token',
  'client_secret', 'client_id', 'app_key', 'senha', 'senha_hash',
  'registration_access_token', 'password', 'secret',
]);

/** Mascara recursivamente objetos/strings, ocultando segredos. */
function mascarar(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    // Mascara padrões dentro de strings (Basic xxx, Bearer xxx, gw-*app-key=xxx).
    return obj
      .replace(/(Basic\s+)([A-Za-z0-9+/=_-]+)/gi, (_m, p) => p + '***')
      .replace(/(Bearer\s+)([A-Za-z0-9._-]+)/gi, (_m, p) => p + '***')
      .replace(/((?:gw-(?:dev-)?app-key|app_key)=)([^&\s]+)/gi, (_m, p) => p + '***');
  }
  if (Array.isArray(obj)) return obj.map(mascarar);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (CHAVES_SENSIVEIS.has(k.toLowerCase())) {
        out[k] = typeof v === 'string' ? mascararStr(v) : '***';
      } else {
        out[k] = mascarar(v);
      }
    }
    return out;
  }
  return obj;
}

function garantirDir() {
  if (!fs.existsSync(DIR_LOGS)) {
    fs.mkdirSync(DIR_LOGS, { recursive: true });
  }
}

/**
 * Grava uma linha de log.
 * @param {string} slug
 * @param {string} ambiente
 * @param {object} dados objeto arbitrário (será mascarado)
 */
function log(slug, ambiente, dados) {
  try {
    garantirDir();
    const linha = JSON.stringify({
      ts: new Date().toISOString(),
      slug,
      ambiente,
      ...mascarar(dados),
    });
    const arquivo = path.join(DIR_LOGS, `pix-${slug || 'sistema'}-${ambiente || 'na'}.log`);
    fs.appendFileSync(arquivo, linha + '\n');
  } catch (e) {
    // Nunca deixa o log derrubar a requisição.
    console.error('[logger] falha ao gravar log:', e.message);
  }
}

/**
 * Lê as últimas N linhas do log de uma empresa+ambiente, já parseadas.
 * As linhas foram gravadas por log() JÁ mascaradas — nenhum segredo é re-exposto.
 * @param {string} slug
 * @param {string} ambiente
 * @param {object} [opts] { limite=100 (max 1000), evento=null }
 * @returns {Array<object>} linhas em ordem cronológica (mais antigas primeiro)
 */
function lerUltimas(slug, ambiente, opts = {}) {
  const arquivo = path.join(DIR_LOGS, `pix-${slug || 'sistema'}-${ambiente || 'na'}.log`);
  if (!fs.existsSync(arquivo)) return [];

  const limite = Math.max(1, Math.min(Number(opts.limite) || 100, 1000));
  const evento = opts.evento ? String(opts.evento) : null;

  const conteudo = fs.readFileSync(arquivo, 'utf8');
  const parsed = [];
  for (const linha of conteudo.split('\n')) {
    if (!linha.trim()) continue;
    let obj;
    try { obj = JSON.parse(linha); } catch (_) { continue; }
    if (evento && obj.evento !== evento) continue;
    parsed.push(obj);
  }
  return parsed.slice(-limite);
}

module.exports = { log, mascarar, lerUltimas, DIR_LOGS };
