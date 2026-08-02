'use strict';

/**
 * Persistência em disco dos payloads CRUS do webhook (rede de segurança:
 * mesmo se a fila cair, o evento fica gravado). Um arquivo por webhook em
 *   webhooks/recebidos/{ambiente}/{ISOts}-{txid}.json
 *
 * SEPARADO POR AMBIENTE (sandbox nunca cruza com producao).
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BASE = path.join(ROOT, 'webhooks', 'recebidos');

const AMBIENTES = ['sandbox', 'producao'];

function ambienteValido(amb) {
  return AMBIENTES.includes(amb) ? amb : 'sandbox';
}

/** ISO seguro para nome de arquivo (sem ':'). */
function tsArquivo(d = new Date()) {
  return d.toISOString().replace(/[:.]/g, '-');
}

/** Sanitiza um pedaço de nome de arquivo. */
function slugArquivo(v, fallback = 'sem-txid') {
  const s = String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
  return s || fallback;
}

/**
 * Deriva um txid representativo do corpo (primeiro pix com txid), só para
 * compor o nome do arquivo. Não é usado como chave de negócio.
 */
function txidDoCorpo(corpo) {
  const lista = corpo && Array.isArray(corpo.pix) ? corpo.pix : [];
  for (const p of lista) {
    if (p && p.txid) return p.txid;
  }
  return null;
}

function garantirDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Salva o payload cru. Retorna { caminho, arquivo, ambiente, recebido_em }.
 * @param {string} ambiente sandbox|producao
 * @param {object} corpo    body do webhook
 * @param {object} [meta]   metadados extras (slug, ip...) gravados junto
 */
function salvar(ambiente, corpo, meta = {}) {
  const amb = ambienteValido(ambiente);
  const dir = path.join(BASE, amb);
  garantirDir(dir);

  const recebidoEm = new Date();
  const txid = txidDoCorpo(corpo);
  const nome = `${tsArquivo(recebidoEm)}-${slugArquivo(txid)}.json`;
  const caminho = path.join(dir, nome);

  const registro = {
    recebido_em: recebidoEm.toISOString(),
    ambiente: amb,
    ...meta,
    corpo,
  };

  fs.writeFileSync(caminho, JSON.stringify(registro, null, 2), 'utf8');

  return { caminho, arquivo: path.relative(ROOT, caminho), ambiente: amb, recebido_em: recebidoEm.toISOString() };
}

/**
 * Lista arquivos salvos de um ambiente, com filtros opcionais.
 * @param {object} opts { ambiente, txid, data (YYYY-MM-DD), limite }
 * @returns lista de { arquivo, ambiente, recebido_em, txids, corpo? }
 */
function listar(opts = {}) {
  const amb = ambienteValido(opts.ambiente);
  const dir = path.join(BASE, amb);
  if (!fs.existsSync(dir)) return [];

  const limite = Number(opts.limite) > 0 ? Number(opts.limite) : 200;
  const incluirCorpo = opts.incluirCorpo === true;

  let arquivos = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));

  // filtro por data (prefixo do nome = ISO ts). ISO começa YYYY-MM-DD.
  if (opts.data) {
    const alvo = String(opts.data).slice(0, 10);
    arquivos = arquivos.filter((f) => f.startsWith(alvo));
  }
  // filtro por txid (sufixo do nome)
  if (opts.txid) {
    const t = slugArquivo(opts.txid);
    arquivos = arquivos.filter((f) => f.includes(t));
  }

  arquivos.sort().reverse(); // mais recentes primeiro
  arquivos = arquivos.slice(0, limite);

  return arquivos.map((f) => {
    const caminho = path.join(dir, f);
    let registro = null;
    try { registro = JSON.parse(fs.readFileSync(caminho, 'utf8')); } catch (_) { registro = null; }
    const corpo = registro && registro.corpo;
    const txids = corpo && Array.isArray(corpo.pix)
      ? corpo.pix.map((p) => p && p.txid).filter(Boolean)
      : [];
    const out = {
      arquivo: f,
      ambiente: amb,
      recebido_em: registro && registro.recebido_em,
      slug: registro && registro.slug,
      txids,
    };
    if (incluirCorpo) out.corpo = corpo;
    return out;
  });
}

/**
 * Retenção: apaga arquivos com mais de `dias` dias (todos os ambientes).
 * Retorna a quantidade apagada.
 */
function limparAntigos(dias = 90) {
  const limiteMs = Date.now() - dias * 24 * 60 * 60 * 1000;
  let apagados = 0;
  for (const amb of AMBIENTES) {
    const dir = path.join(BASE, amb);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const caminho = path.join(dir, f);
      try {
        const st = fs.statSync(caminho);
        if (st.mtimeMs < limiteMs) {
          fs.unlinkSync(caminho);
          apagados += 1;
        }
      } catch (_) { /* ignora */ }
    }
  }
  return apagados;
}

module.exports = { salvar, listar, limparAntigos, BASE, AMBIENTES };
