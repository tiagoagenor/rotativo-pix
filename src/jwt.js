'use strict';

/**
 * Emissão/verificação de JWT (HS256, 24h).
 */

const jwt = require('jsonwebtoken');

const EXPIRA_EM = '24h';

function segredo() {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error('JWT_SECRET não definido (configure o .env)');
  }
  return s;
}

/**
 * Emite um token válido por 24h.
 * @param {string} empresa  slug da empresa
 * @param {string} usuario  nome do usuário da API
 * @param {string} ambiente sandbox|producao (o token só vale nesse ambiente)
 * @returns {{token:string, expira_em:string}}
 */
function emitir(empresa, usuario, ambiente) {
  const payload = { empresa, usuario, ambiente, tipo: 'pix-api' };
  const token = jwt.sign(payload, segredo(), { expiresIn: EXPIRA_EM });
  const decoded = jwt.decode(token);
  const expiraEm = decoded && decoded.exp
    ? new Date(decoded.exp * 1000).toISOString()
    : null;
  return { token, expira_em: expiraEm };
}

/**
 * Verifica um token. Retorna o payload ou null se inválido/expirado.
 */
function verificar(token) {
  try {
    return jwt.verify(token, segredo());
  } catch (_) {
    return null;
  }
}

module.exports = { emitir, verificar, EXPIRA_EM };
