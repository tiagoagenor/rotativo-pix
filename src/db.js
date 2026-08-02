'use strict';

/**
 * Pool MySQL (mysql2/promise) resolvido POR AMBIENTE conforme DB_POR_AMBIENTE.
 *
 *   DB_POR_AMBIENTE=false  -> um único banco (DB_HOST/DB_PORT/DB_DATABASE/DB_USERNAME/DB_PASSWORD)
 *                             usado tanto por sandbox quanto por producao.
 *   DB_POR_AMBIENTE=true   -> bancos separados por ambiente:
 *                             DB_SANDBOX_*  e  DB_PRODUCAO_*
 *
 * O worker escreve DIRETO no banco do backend (Laravel), replicando o
 * PixPaymentStrategy::confirm(). Um pool por ambiente (lazy) é mantido em cache.
 */

const mysql = require('mysql2/promise');

const AMBIENTES = ['sandbox', 'producao'];

/** true/1/yes => true. */
function boolEnv(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|sim|on)$/i.test(String(v).trim());
}

function porAmbiente() {
  return boolEnv(process.env.DB_POR_AMBIENTE, false);
}

/**
 * Monta as opções de conexão do pool para um ambiente.
 * Prefixo vazio (banco único) ou DB_SANDBOX_/DB_PRODUCAO_ (por ambiente).
 */
function opcoesDoAmbiente(ambiente) {
  const usarPrefixo = porAmbiente();
  const p = usarPrefixo ? `DB_${ambiente.toUpperCase()}_` : 'DB_';

  const pick = (sufixo, ...fallbacks) => {
    const chaves = [`${p}${sufixo}`, ...fallbacks];
    for (const k of chaves) {
      if (process.env[k] != null && process.env[k] !== '') return process.env[k];
    }
    return undefined;
  };

  const host = pick('HOST');
  const port = Number(pick('PORT')) || 3306;
  const database = pick('DATABASE', 'DB_NAME');
  const user = pick('USERNAME', `${p}USER`, 'DB_USER');
  const password = pick('PASSWORD', `${p}PASS`);

  if (!host || !database || !user) {
    throw new Error(
      `Config de banco incompleta para ambiente "${ambiente}" ` +
      `(faltam ${p}HOST/${p}DATABASE/${p}USERNAME). DB_POR_AMBIENTE=${usarPrefixo}`
    );
  }

  return {
    host,
    port,
    database,
    user,
    password: password || '',
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_POOL_LIMIT) || 10,
    maxIdle: Number(process.env.DB_POOL_LIMIT) || 10,
    idleTimeout: 60000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    timezone: 'Z',
    // decimais como string pra não perder precisão em dinheiro.
    decimalNumbers: false,
  };
}

const pools = new Map(); // ambiente -> pool

/**
 * Retorna (criando na 1ª vez) o pool do ambiente. Quando DB_POR_AMBIENTE=false,
 * sandbox e producao compartilham o MESMO pool ("_unico").
 */
function pool(ambiente) {
  if (!AMBIENTES.includes(ambiente)) {
    throw new Error(`Ambiente inválido "${ambiente}" (use sandbox|producao)`);
  }
  const chave = porAmbiente() ? ambiente : '_unico';
  if (!pools.has(chave)) {
    pools.set(chave, mysql.createPool(opcoesDoAmbiente(ambiente)));
  }
  return pools.get(chave);
}

/**
 * Pega uma conexão dedicada do pool do ambiente (para transações).
 * Lembre de liberar com conn.release().
 */
async function conexao(ambiente) {
  return pool(ambiente).getConnection();
}

/**
 * Executa um callback DENTRO de uma transação MySQL. Faz commit no sucesso e
 * rollback no erro; sempre libera a conexão. O callback recebe a conexão.
 */
async function transacao(ambiente, callback) {
  const conn = await conexao(ambiente);
  try {
    await conn.beginTransaction();
    const r = await callback(conn);
    await conn.commit();
    return r;
  } catch (e) {
    try { await conn.rollback(); } catch (_) { /* ignora */ }
    throw e;
  } finally {
    conn.release();
  }
}

/** Ping simples pra healthcheck. */
async function ping(ambiente) {
  const [rows] = await pool(ambiente).query('SELECT 1 AS ok');
  return rows && rows[0] && rows[0].ok === 1;
}

/** Fecha todos os pools (shutdown gracioso). */
async function fecharTudo() {
  const ps = Array.from(pools.values());
  pools.clear();
  await Promise.all(ps.map((p) => p.end().catch(() => {})));
}

module.exports = {
  AMBIENTES,
  porAmbiente,
  pool,
  conexao,
  transacao,
  ping,
  fecharTudo,
  opcoesDoAmbiente,
};
