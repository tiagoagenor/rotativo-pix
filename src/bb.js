'use strict';

/**
 * Cliente HTTP para a API PIX v2 do Banco do Brasil.
 * Usa o módulo nativo `https` + https.Agent para mTLS opcional.
 */

const https = require('https');
const fs = require('fs');
const { URL } = require('url');
const crypto = require('crypto');

/** Mascara um segredo para logs. */
function mask(v) {
  if (typeof v !== 'string' || !v) return v;
  if (v.length <= 8) return '***';
  return `${v.slice(0, 4)}…${v.slice(-2)}`;
}

/**
 * Resume a resposta do BB para algo legível.
 * - JSON do BB -> retorna como está (já é limpo).
 * - Página HTML de erro do BB -> extrai mensagem + ID + IP + causas prováveis.
 * - Texto qualquer -> trunca em 500 chars.
 */
function resumirResposta(resp) {
  if (resp.json) return resp.json;
  const body = resp.body || '';

  if (/<html/i.test(body)) {
    const pega = (re) => {
      const m = body.match(re);
      return m ? m[1].replace(/<[^>]+>/g, '').trim() : null;
    };
    const mensagem = pega(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    const id = pega(/ID:\s*([A-Za-z0-9]+)/i);
    const ip = pega(/IP:\s*([0-9a-fA-F:.]+)/i);
    return {
      tipo: 'erro_html_bb',
      mensagem: mensagem || 'Banco do Brasil recusou a requisição (página HTML de erro).',
      id_seguranca: id,
      ip_origem: ip,
      possiveis_causas: [
        'Credenciais (basic / app_key) inválidas ou de outro ambiente',
        'App sem os escopos pedidos (cob.write, cob.read, pix.read)',
        'IP de origem não liberado para o app no portal do BB',
      ],
    };
  }

  return body ? body.slice(0, 500) : null;
}

/**
 * Monta o objeto `devedor` (quem paga) no formato do BB.
 * Aceita { cpf, nome } OU { cnpj, nome }. Retorna null se incompleto.
 */
function montarDevedor(devedor) {
  if (!devedor || typeof devedor !== 'object') return null;
  const nome = devedor.nome ? String(devedor.nome).trim().slice(0, 200) : null;
  if (!nome) return null;

  const cpf = devedor.cpf ? String(devedor.cpf).replace(/\D/g, '') : null;
  const cnpj = devedor.cnpj ? String(devedor.cnpj).replace(/\D/g, '') : null;

  if (cpf && cpf.length === 11) return { cpf, nome };
  if (cnpj && cnpj.length === 14) return { cnpj, nome };
  return null; // sem documento válido, o BB rejeita o devedor
}

/**
 * Monta `infoAdicionais`: lista de { nome, valor } (máx. 50 itens).
 */
function montarInfoAdicionais(lista) {
  if (!Array.isArray(lista) || lista.length === 0) return null;
  const itens = lista
    .filter((i) => i && i.nome != null && i.valor != null)
    .slice(0, 50)
    .map((i) => ({
      nome: String(i.nome).slice(0, 50),
      valor: String(i.valor).slice(0, 200),
    }));
  return itens.length ? itens : null;
}

/** Gera um txid alfanumérico (26–35 chars). BB exige [A-Za-z0-9]{26,35}. */
function gerarTxid() {
  const alfabeto = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const tam = 32; // dentro de 26..35
  let out = '';
  const bytes = crypto.randomBytes(tam);
  for (let i = 0; i < tam; i++) {
    out += alfabeto[bytes[i] % alfabeto.length];
  }
  return out;
}

/**
 * Monta o https.Agent conforme a config (mTLS + rejectUnauthorized).
 * Retorna { agent, mtls, ca } — mtls/ca só para debug.
 */
function montarAgent(cfg) {
  const opts = {};
  let mtls = false;
  let caCarregada = false;

  // mTLS apenas quando api_base == com_mtls e existir o cert do cliente.
  if (cfg.api_base === 'com_mtls' && cfg.cert_cliente && fs.existsSync(cfg.cert_cliente)) {
    const conteudo = fs.readFileSync(cfg.cert_cliente);
    if (cfg.cert_cliente.toLowerCase().endsWith('.pfx') || cfg.cert_cliente.toLowerCase().endsWith('.p12')) {
      opts.pfx = conteudo;
      if (process.env.CERT_PASSPHRASE) opts.passphrase = process.env.CERT_PASSPHRASE;
    } else {
      // PEM: cert + key normalmente no mesmo arquivo (cert + chave privada).
      opts.cert = conteudo;
      opts.key = conteudo;
      if (process.env.CERT_PASSPHRASE) opts.passphrase = process.env.CERT_PASSPHRASE;
    }
    mtls = true;
  }

  // CA pública do BB (verificar o servidor), se existir.
  if (cfg.cert_ca && fs.existsSync(cfg.cert_ca)) {
    opts.ca = fs.readFileSync(cfg.cert_ca);
    caCarregada = true;
  }

  // ignorar_tls só deve valer em sandbox (Extranet usa CA interna).
  if (cfg.ignorar_tls === true) {
    opts.rejectUnauthorized = false;
  }

  return { agent: new https.Agent(opts), mtls, ca: caCarregada };
}

/**
 * Requisição HTTPS genérica.
 * @returns {Promise<{status:number, headers:object, body:string, json:object|null}>}
 */
function requisitar({ method, urlStr, headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opcoes = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: headers || {},
      agent,
    };
    const req = https.request(opcoes, (res) => {
      let dados = '';
      res.on('data', (c) => { dados += c; });
      res.on('end', () => {
        let json = null;
        try { json = dados ? JSON.parse(dados) : null; } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: dados, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * OAuth client_credentials.
 * @returns {Promise<{ok, status, access_token, debug}>}
 */
async function oauth(cfg) {
  const { agent, mtls, ca } = montarAgent(cfg);
  const basic = cfg.credenciais.basic || '';
  const scope = cfg.oauth_scopes || '';
  const corpo = `grant_type=client_credentials&scope=${encodeURIComponent(scope)}`;

  const debug = {
    passo: 'oauth',
    url: cfg.oauth_url,
    metodo: 'POST',
    mtls,
    ca_carregada: ca,
    ignorar_tls: cfg.ignorar_tls === true,
    authorization: `Basic ${mask(basic)}`,
    scope,
  };

  const resp = await requisitar({
    method: 'POST',
    urlStr: cfg.oauth_url,
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(corpo),
    },
    body: corpo,
    agent,
  });

  const accessToken = resp.json && resp.json.access_token;
  return {
    ok: resp.status >= 200 && resp.status < 300 && !!accessToken,
    status: resp.status,
    access_token: accessToken || null,
    resposta: resumirResposta(resp),
    debug: { ...debug, status: resp.status },
  };
}

/**
 * Cria uma cobrança imediata (PUT /cob/{txid}).
 */
async function criarCobranca(cfg, { valor, descricao, txid, devedor, infoAdicionais, expiracao } = {}) {
  const { agent, mtls, ca } = montarAgent(cfg);

  // OAuth primeiro
  const auth = await oauth(cfg);
  if (!auth.ok) {
    return { ok: false, etapa: 'oauth', status: auth.status, resposta: auth.resposta, debug: auth.debug };
  }

  const txidFinal = (txid && /^[A-Za-z0-9]{26,35}$/.test(txid)) ? txid : gerarTxid();
  const appKey = cfg.credenciais.app_key || '';
  const urlStr = `${cfg.api_url}/cob/${txidFinal}?${cfg.app_key_param}=${encodeURIComponent(appKey)}`;

  const valorStr = (valor != null) ? String(valor) : '1.00';
  const payload = {
    calendario: { expiracao: Number(expiracao) > 0 ? Number(expiracao) : 3600 },
    valor: { original: valorStr },
    chave: cfg.chave_pix,
  };

  // Devedor (quem paga): nome + (cpf OU cnpj). BB exige exatamente um dos dois.
  const dev = montarDevedor(devedor);
  if (dev) payload.devedor = dev;

  // Mensagem que aparece pro pagador (até 140 chars).
  if (descricao) payload.solicitacaoPagador = String(descricao).slice(0, 140);

  // Informações adicionais: lista de { nome, valor } (até 50 itens).
  const infos = montarInfoAdicionais(infoAdicionais);
  if (infos) payload.infoAdicionais = infos;

  const corpo = JSON.stringify(payload);

  const debug = {
    passo: 'criar_cobranca',
    url: `${cfg.api_url}/cob/${txidFinal}?${cfg.app_key_param}=${mask(appKey)}`,
    metodo: 'PUT',
    mtls,
    ca_carregada: ca,
    authorization: `Bearer ${mask(auth.access_token)}`,
    txid: txidFinal,
    payload: { ...payload, chave: mask(cfg.chave_pix) },
  };

  const resp = await requisitar({
    method: 'PUT',
    urlStr,
    headers: {
      'Authorization': `Bearer ${auth.access_token}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(corpo),
    },
    body: corpo,
    agent,
  });

  const j = resp.json || {};
  const copiaCola = j.pixCopiaECola || (j.textoImagemQRcode) || null;

  return {
    ok: resp.status >= 200 && resp.status < 300,
    etapa: 'criar_cobranca',
    status: resp.status,
    txid: txidFinal,
    copia_cola: copiaCola,
    resposta: resumirResposta(resp),
    debug: { ...debug, status: resp.status, oauth_debug: auth.debug },
  };
}

/**
 * Consulta uma cobrança (GET /cob/{txid}).
 */
async function consultarCobranca(cfg, txid) {
  const { agent, mtls, ca } = montarAgent(cfg);

  const auth = await oauth(cfg);
  if (!auth.ok) {
    return { ok: false, etapa: 'oauth', status: auth.status, resposta: auth.resposta, debug: auth.debug };
  }

  const appKey = cfg.credenciais.app_key || '';
  const urlStr = `${cfg.api_url}/cob/${txid}?${cfg.app_key_param}=${encodeURIComponent(appKey)}`;

  const debug = {
    passo: 'consultar_cobranca',
    url: `${cfg.api_url}/cob/${txid}?${cfg.app_key_param}=${mask(appKey)}`,
    metodo: 'GET',
    mtls,
    ca_carregada: ca,
    authorization: `Bearer ${mask(auth.access_token)}`,
    txid,
  };

  const resp = await requisitar({
    method: 'GET',
    urlStr,
    headers: { 'Authorization': `Bearer ${auth.access_token}` },
    agent,
  });

  return {
    ok: resp.status >= 200 && resp.status < 300,
    etapa: 'consultar_cobranca',
    status: resp.status,
    txid,
    resposta: resumirResposta(resp),
    debug: { ...debug, status: resp.status },
  };
}

module.exports = { oauth, criarCobranca, consultarCobranca, gerarTxid, mask };
