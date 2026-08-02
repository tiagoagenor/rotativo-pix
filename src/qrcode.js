'use strict';

/**
 * Geração de QR Code (data URI) a partir do "copia e cola" do PIX.
 */

const QRCode = require('qrcode');

/**
 * Gera um QR Code como data URI.
 * @param {string} texto  copia-e-cola (payload BR Code)
 * @param {object} [opts] { tipo: 'png'|'svg' }
 * @returns {Promise<string>} data URI
 */
async function gerarDataUri(texto, opts = {}) {
  const tipo = (opts.tipo || 'png').toLowerCase();
  if (!texto) throw new Error('texto vazio para QR Code');

  if (tipo === 'svg') {
    const svg = await QRCode.toString(texto, { type: 'svg', margin: 1, width: 300 });
    const b64 = Buffer.from(svg, 'utf8').toString('base64');
    return `data:image/svg+xml;base64,${b64}`;
  }
  // PNG (default)
  return QRCode.toDataURL(texto, { margin: 1, width: 300 });
}

module.exports = { gerarDataUri };
