'use strict';

/**
 * Checagem de IP (IPv4) dentro de uma faixa CIDR.
 */

/** Converte "a.b.c.d" em inteiro 32 bits (ou null se inválido). */
function ipParaInt(ip) {
  if (typeof ip !== 'string') return null;
  // Normaliza IPv4 mapeado em IPv6 (::ffff:1.2.3.4)
  const m = ip.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (!m) return null;
  const partes = m[1].split('.').map(Number);
  if (partes.length !== 4 || partes.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return ((partes[0] << 24) >>> 0) + (partes[1] << 16) + (partes[2] << 8) + partes[3];
}

/**
 * @param {string} ip   IP a testar (aceita ::ffff:1.2.3.4)
 * @param {string} cidr faixa "a.b.c.d/n"
 * @returns {boolean}
 */
function ipEmCidr(ip, cidr) {
  if (!cidr || typeof cidr !== 'string') return false;
  const [rede, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  if (Number.isNaN(bits) || bits < 0 || bits > 32) return false;

  const ipInt = ipParaInt(ip);
  const redeInt = ipParaInt(rede);
  if (ipInt == null || redeInt == null) return false;

  if (bits === 0) return true;
  const mascara = (0xffffffff << (32 - bits)) >>> 0;
  return (ipInt & mascara) === (redeInt & mascara);
}

/**
 * Verifica se um IP está numa LISTA de permissões.
 * Cada item pode ser:
 *   - um IP único: "201.33.144.10"  (tratado como /32)
 *   - um range CIDR: "170.66.0.0/16"
 * A lista pode vir como array ou string separada por vírgula/espaço/;
 * @returns {boolean}
 */
function ipPermitido(ip, lista) {
  const itens = normalizarLista(lista);
  if (itens.length === 0) return false;
  return itens.some((item) => {
    const cidr = item.includes('/') ? item : `${item}/32`;
    return ipEmCidr(ip, cidr);
  });
}

/** Normaliza a lista de IPs/ranges em um array de strings limpas. */
function normalizarLista(lista) {
  let arr = [];
  if (Array.isArray(lista)) arr = lista;
  else if (typeof lista === 'string') arr = lista.split(/[,;\s]+/);
  return arr.map((s) => String(s).trim()).filter(Boolean);
}

module.exports = { ipEmCidr, ipParaInt, ipPermitido, normalizarLista };
