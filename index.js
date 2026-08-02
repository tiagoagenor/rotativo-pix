'use strict';

/**
 * Microserviço PIX (Banco do Brasil) — standalone, sem Laravel, sem banco.
 * Servidor HTTP com Express.
 */

require('dotenv').config();

const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('./src/config');
const jwtUtil = require('./src/jwt');
const bb = require('./src/bb');
const qrcode = require('./src/qrcode');
const logger = require('./src/logger');
const { ipEmCidr, ipPermitido, normalizarLista } = require('./src/cidr');

const app = express();
app.set('trust proxy', true); // respeita X-Forwarded-For quando atrás de proxy
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extrairBearer(req) {
  const h = req.headers['authorization'] || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

const AMBIENTES = ['sandbox', 'producao'];

/** Middleware: valida o :ambiente da URL (sandbox|producao). */
function validarAmbiente(req, res, next) {
  const amb = req.params.ambiente;
  if (!AMBIENTES.includes(amb)) {
    return res.status(404).json({ ok: false, erro: 'Ambiente inválido (use sandbox|producao)' });
  }
  next();
}

/**
 * Middleware: exige JWT válido; injeta req.auth = payload. Se a rota tiver
 * :ambiente, o token PRECISA ser desse ambiente (um token de sandbox não vale
 * em produção e vice-versa).
 */
function exigirJwt(req, res, next) {
  const token = extrairBearer(req);
  if (!token) {
    return res.status(401).json({ ok: false, erro: 'Token ausente (Authorization: Bearer ...)' });
  }
  const payload = jwtUtil.verificar(token);
  if (!payload) {
    return res.status(401).json({ ok: false, erro: 'Token inválido ou expirado' });
  }
  const amb = req.params.ambiente;
  if (amb && payload.ambiente && payload.ambiente !== amb) {
    return res.status(401).json({ ok: false, erro: `Token é do ambiente "${payload.ambiente}", não "${amb}"` });
  }
  req.auth = payload;
  next();
}

/**
 * Acha o usuário no api-usuarios.json para um AMBIENTE.
 * Formato novo: { "slug": { "sandbox": {usuario,senha}, "producao": {...} } }
 * Formato antigo (compat): { "slug": { usuario, senha } } — vale para os 2 ambientes.
 */
function acharUsuario(usuario, ambiente) {
  const todos = config.usuarios();
  for (const [slug, r] of Object.entries(todos)) {
    if (!r) continue;
    const porAmbiente = r[ambiente];               // formato novo
    if (porAmbiente && porAmbiente.usuario === usuario) {
      return { slug, registro: porAmbiente };
    }
    if (!r.sandbox && !r.producao && r.usuario === usuario) { // formato antigo
      return { slug, registro: r };
    }
  }
  return null;
}

/**
 * Filtro de IP dos ENDPOINTS da API (token/cobrança/consulta).
 * Lista separada da do webhook (cfg.api.ips). Aceita IP único ou range.
 * Retorna true se pode seguir; se bloquear, já responde 403 e retorna false.
 * flag desligada, ou ligada sem lista => não bloqueia.
 */
function apiIpLiberado(cfg, req, res, slug, ambiente) {
  const api = cfg && cfg.api;
  if (!api || !api.restringe_ip) return true;
  const lista = normalizarLista(api.ips);
  if (lista.length === 0) return true;
  const ip = ipCliente(req);
  if (ipPermitido(ip, lista)) return true;
  logger.log(slug, ambiente, { evento: 'api_ip_bloqueado', ip, permitidos: lista });
  res.status(403).json({ ok: false, erro: 'IP não autorizado para a API' });
  return false;
}

/** Confere a senha (texto "senha" ou bcrypt "senha_hash"). */
function senhaConfere(registro, senha) {
  if (registro.senha_hash) {
    try { return bcrypt.compareSync(senha, registro.senha_hash); } catch (_) { return false; }
  }
  return typeof registro.senha === 'string' && registro.senha === senha;
}

/** IP do cliente (considera X-Forwarded-For). */
function ipCliente(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || req.ip;
}

/** Descrição dos endpoints do ambiente (retornada no login). */
function endpointsInfo(ambiente) {
  return {
    gerar_cobranca: { metodo: 'POST', path: `/api/pix/${ambiente}/cobranca` },
    consultar_cobranca: { metodo: 'GET', path: `/api/pix/${ambiente}/cobranca/{txid}` },
  };
}

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------

// Health
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, servico: 'rotativo-pix', ambiente_global: safe(() => config.ambienteGlobal()) });
});

function safe(fn) {
  try { return fn(); } catch (_) { return null; }
}

// 1) Login -> JWT  (por ambiente: /api/pix/sandbox/token ou /api/pix/producao/token)
app.post('/api/pix/:ambiente/token', validarAmbiente, (req, res) => {
  const ambiente = req.params.ambiente;
  const { usuario, senha } = req.body || {};
  if (!usuario || !senha) {
    return res.status(400).json({ ok: false, erro: 'Informe usuario e senha' });
  }

  const negar = () => res.status(401).json({ ok: false, erro: 'Credenciais inválidas' });

  const achado = acharUsuario(usuario, ambiente);
  if (!achado || !senhaConfere(achado.registro, senha)) return negar();

  const slug = achado.slug;

  // Filtro de IP da API (lista própria, separada do webhook).
  let cfgApi = null;
  try { cfgApi = config.configEmpresa(slug, ambiente); } catch (_) { cfgApi = null; }
  if (cfgApi && !apiIpLiberado(cfgApi, req, res, slug, ambiente)) return;

  const { token, expira_em } = jwtUtil.emitir(slug, usuario, ambiente);

  logger.log(slug, ambiente, { evento: 'login', usuario, ambiente, resultado: 'ok' });

  return res.json({
    token,
    tipo: 'Bearer',
    expira_em,
    empresa: slug,
    ambiente,
    endpoints: endpointsInfo(ambiente),
  });
});

// 2) Gerar cobrança  (/api/pix/:ambiente/cobranca)
app.post('/api/pix/:ambiente/cobranca', validarAmbiente, exigirJwt, async (req, res) => {
  const slug = req.auth.empresa;
  const ambiente = req.params.ambiente;
  const { valor, descricao, txid, devedor, expiracao } = req.body || {};
  const infoAdicionais = (req.body && (req.body.info_adicionais || req.body.infoAdicionais)) || null;
  let apiBaseOverride = req.body && req.body.api_base;

  let cfg;
  try {
    // Override de api_base só é permitido em sandbox.
    if (apiBaseOverride && ambiente !== 'sandbox') apiBaseOverride = undefined;
    cfg = config.configEmpresa(slug, ambiente, apiBaseOverride);
  } catch (e) {
    return res.status(400).json({ ok: false, erro: e.message });
  }

  if (!apiIpLiberado(cfg, req, res, slug, ambiente)) return;

  try {
    const resultado = await bb.criarCobranca(cfg, { valor, descricao, txid, devedor, infoAdicionais, expiracao });

    logger.log(slug, ambiente, {
      evento: 'criar_cobranca',
      api_base: cfg.api_base,
      status: resultado.status,
      etapa: resultado.etapa,
      txid: resultado.txid,
      debug: resultado.debug,
    });

    if (!resultado.ok) {
      return res.status(502).json({
        ok: false,
        ambiente,
        api_base: cfg.api_base,
        etapa: resultado.etapa,
        status_bb: resultado.status,
        erro: 'Falha na API do BB',
        resposta_bb: resultado.resposta,
      });
    }

    let qr = null;
    if (resultado.copia_cola) {
      try { qr = await qrcode.gerarDataUri(resultado.copia_cola, { tipo: 'png' }); } catch (_) { qr = null; }
    }

    return res.json({
      ok: true,
      ambiente,
      api_base: cfg.api_base,
      txid: resultado.txid,
      copia_cola: resultado.copia_cola,
      qrcode: qr,
    });
  } catch (e) {
    logger.log(slug, ambiente, { evento: 'criar_cobranca', erro: e.message });
    return res.status(500).json({ ok: false, erro: 'Erro interno', detalhe: e.message });
  }
});

// 3) Consultar cobrança  (/api/pix/:ambiente/cobranca/:txid)
app.get('/api/pix/:ambiente/cobranca/:txid', validarAmbiente, exigirJwt, async (req, res) => {
  const slug = req.auth.empresa;
  const ambiente = req.params.ambiente;
  const { txid } = req.params;

  let cfg;
  try {
    cfg = config.configEmpresa(slug, ambiente);
  } catch (e) {
    return res.status(400).json({ ok: false, erro: e.message });
  }

  if (!apiIpLiberado(cfg, req, res, slug, ambiente)) return;

  try {
    const resultado = await bb.consultarCobranca(cfg, txid);
    logger.log(slug, ambiente, {
      evento: 'consultar_cobranca',
      status: resultado.status,
      etapa: resultado.etapa,
      txid,
      debug: resultado.debug,
    });

    if (!resultado.ok) {
      return res.status(502).json({
        ok: false,
        ambiente,
        etapa: resultado.etapa,
        status_bb: resultado.status,
        erro: 'Falha na API do BB',
        resposta_bb: resultado.resposta,
      });
    }
    return res.json({ ok: true, ambiente, txid, cobranca: resultado.resposta });
  } catch (e) {
    logger.log(slug, ambiente, { evento: 'consultar_cobranca', erro: e.message });
    return res.status(500).json({ ok: false, erro: 'Erro interno', detalhe: e.message });
  }
});

// 4) Webhook do BB (PÚBLICO, sem JWT)
function tratarWebhook(req, res) {
  const { token } = req.params;
  const cfg = config.acharPorTokenWebhook(token);

  if (!cfg) {
    return res.status(404).json({ ok: false, erro: 'Webhook não encontrado' });
  }

  const ip = ipCliente(req);

  // Filtro de IP, se ligado (flag restringe_ip).
  // Lista permitida = webhook.ips do config (IP único ou range).
  // Se a lista estiver vazia, cai no range padrão do BB (bb.json).
  if (cfg.webhook && cfg.webhook.restringe_ip) {
    const listaConfig = normalizarLista(cfg.webhook.ips);
    const usaLista = listaConfig.length > 0;         // lista própria do config
    const permitido = usaLista
      ? ipPermitido(ip, listaConfig)
      : ipEmCidr(ip, cfg.webhook_ips);               // fallback: range do BB
    if (!permitido) {
      logger.log(cfg.slug, cfg.ambiente, {
        evento: 'webhook',
        resultado: '403_ip_nao_autorizado',
        ip,
        permitidos: usaLista ? listaConfig : cfg.webhook_ips,
      });
      return res.status(403).json({ ok: false, erro: 'IP não autorizado' });
    }
  }

  logger.log(cfg.slug, cfg.ambiente, {
    evento: 'webhook',
    resultado: 'ok',
    ip,
    corpo: req.body,
  });

  // BB espera 200.
  return res.status(200).json({ ok: true });
}

app.post('/webhook/pix/bb/:token', tratarWebhook);
// O BB às vezes acrescenta /pix à URL registrada — aceitamos as duas formas.
app.post('/webhook/pix/bb/:token/pix', tratarWebhook);

// 404 genérico
app.use((req, res) => {
  res.status(404).json({ ok: false, erro: 'Rota não encontrada' });
});

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`[rotativo-pix] escutando na porta ${PORT}`);
  try {
    console.log(`[rotativo-pix] ambiente global: ${config.ambienteGlobal()}`);
  } catch (e) {
    console.warn(`[rotativo-pix] aviso: ${e.message}`);
  }
  if (!process.env.JWT_SECRET) {
    console.warn('[rotativo-pix] AVISO: JWT_SECRET não definido — defina no .env');
  }
});

module.exports = app;
