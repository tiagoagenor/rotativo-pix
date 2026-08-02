'use strict';

/**
 * Leitura das configurações (JSONs) do microserviço PIX.
 * Nada de banco de dados — apenas arquivos no disco.
 */

const fs = require('fs');
const path = require('path');

// Raiz do projeto = pasta acima de src/
const ROOT = path.resolve(__dirname, '..');

function lerJson(caminhoAbsoluto) {
  const bruto = fs.readFileSync(caminhoAbsoluto, 'utf8');
  return JSON.parse(bruto);
}

/** Ambiente global do sistema (sandbox | producao). Lê sistema.json. */
function ambienteGlobal() {
  const s = lerJson(path.join(ROOT, 'sistema.json'));
  const amb = (s.ambiente || 'sandbox').trim();
  if (amb !== 'sandbox' && amb !== 'producao') {
    throw new Error(`sistema.json: ambiente inválido "${amb}" (use sandbox|producao)`);
  }
  return amb;
}

/** Config pública do banco (bancos/{banco}.json). */
function configBanco(banco) {
  return lerJson(path.join(ROOT, 'bancos', `${banco}.json`));
}

/** Dados não sensíveis da empresa (empresas/{slug}/empresa.json). */
function empresaBase(slug) {
  const caminho = path.join(ROOT, 'empresas', slug, 'empresa.json');
  if (!fs.existsSync(caminho)) {
    throw new Error(`Empresa "${slug}" não encontrada (${caminho})`);
  }
  return lerJson(caminho);
}

/** Usuários da API externa (api-usuarios.json). */
function usuarios() {
  const caminho = path.join(ROOT, 'api-usuarios.json');
  if (!fs.existsSync(caminho)) return {};
  return lerJson(caminho);
}

/**
 * Resolve a configuração completa de uma empresa em um ambiente.
 *
 * @param {string} slug            slug da empresa
 * @param {string} [ambiente]      sandbox|producao (default = ambiente global)
 * @param {string} [apiBaseOverride] sem_mtls|com_mtls (só vale se existir no ambiente)
 * @returns objeto com credenciais, api_url, caminhos absolutos de certs, etc.
 */
function configEmpresa(slug, ambiente, apiBaseOverride) {
  const amb = ambiente || ambienteGlobal();
  const base = empresaBase(slug);

  if (base.ativo === false) {
    throw new Error(`Empresa "${slug}" está inativa`);
  }

  const dirAmbiente = path.join(ROOT, 'empresas', slug, amb);
  const caminhoConfig = path.join(dirAmbiente, 'config.json');
  if (!fs.existsSync(caminhoConfig)) {
    throw new Error(`Config do ambiente "${amb}" não encontrada para "${slug}" (${caminhoConfig})`);
  }
  const cfg = lerJson(caminhoConfig);

  if (cfg.ativo === false) {
    throw new Error(`Empresa "${slug}" está inativa no ambiente "${amb}"`);
  }

  const banco = configBanco(base.banco || 'bb');
  const ambBanco = banco.ambientes[amb];
  if (!ambBanco) {
    throw new Error(`Banco "${base.banco}" não tem ambiente "${amb}"`);
  }

  // Resolve api_base: só aceita override se a base existir naquele ambiente.
  // (produção só tem com_mtls -> override para sem_mtls é ignorado)
  let apiBase = cfg.api_base;
  if (apiBaseOverride && ambBanco.api_bases[apiBaseOverride]) {
    apiBase = apiBaseOverride;
  }
  const apiUrl = ambBanco.api_bases[apiBase];
  if (!apiUrl) {
    throw new Error(`api_base "${apiBase}" indisponível no ambiente "${amb}" do banco "${base.banco}"`);
  }

  // Caminhos absolutos dos certificados (podem não existir ainda).
  const certs = cfg.certificados || {};
  const certCliente = certs.cliente ? path.resolve(dirAmbiente, certs.cliente) : null;
  const certCa = certs.ca ? path.resolve(dirAmbiente, certs.ca) : null;

  return {
    slug,
    ambiente: amb,
    empresa: base,
    banco: base.banco || 'bb',

    // Seleção de base / TLS
    api_base: apiBase,
    api_url: apiUrl,
    ignorar_tls: cfg.ignorar_tls === true,

    // Endpoints do banco para este ambiente
    oauth_url: ambBanco.oauth_url,
    app_key_param: ambBanco.app_key_param,
    oauth_scopes: banco.oauth_scopes,
    webhook_ips: ambBanco.webhook_ips,

    // Dados da empresa
    credenciais: cfg.credenciais || {},
    chave_pix: cfg.chave_pix,
    webhook: cfg.webhook || {},
    api: cfg.api || {},

    // Certificados (caminhos absolutos)
    cert_cliente: certCliente,
    cert_ca: certCa,

    // Bruto (para debug se necessário)
    _bancoConfig: banco,
    _dirAmbiente: dirAmbiente,
  };
}

/**
 * Varre todas as empresas/ambientes e retorna a config cujo webhook.token
 * bate com o token informado. Retorna null se nenhum bater.
 */
function acharPorTokenWebhook(token) {
  const dirEmpresas = path.join(ROOT, 'empresas');
  if (!fs.existsSync(dirEmpresas)) return null;

  const slugs = fs.readdirSync(dirEmpresas, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  for (const slug of slugs) {
    for (const amb of ['sandbox', 'producao']) {
      const caminhoConfig = path.join(dirEmpresas, slug, amb, 'config.json');
      if (!fs.existsSync(caminhoConfig)) continue;
      let cfg;
      try {
        cfg = lerJson(caminhoConfig);
      } catch (_) {
        continue;
      }
      const t = cfg.webhook && cfg.webhook.token;
      if (t && t === token) {
        // Reaproveita o resolvedor completo (pega webhook_ips do banco etc.)
        try {
          return configEmpresa(slug, amb);
        } catch (e) {
          // Empresa/ambiente inativos ainda contam para o match do webhook.
          // Resolve webhook_ips do banco mesmo assim, para o filtro de IP funcionar.
          let webhookIps = null;
          try {
            const base = empresaBase(slug);
            const banco = configBanco(base.banco || 'bb');
            webhookIps = banco.ambientes[amb] && banco.ambientes[amb].webhook_ips;
          } catch (_) { /* ignora */ }
          return {
            slug,
            ambiente: amb,
            webhook: cfg.webhook,
            webhook_ips: webhookIps,
            _inativo: true,
            _erro: e.message,
          };
        }
      }
    }
  }
  return null;
}

module.exports = {
  ROOT,
  ambienteGlobal,
  configBanco,
  empresaBase,
  usuarios,
  configEmpresa,
  acharPorTokenWebhook,
};
