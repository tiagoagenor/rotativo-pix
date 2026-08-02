# rotativo-pix — Microserviço Node.js (PIX / Banco do Brasil)

Microserviço **standalone** (Express) para gerar/consultar cobranças PIX no
Banco do Brasil e receber o webhook do BB. **Sem Laravel, sem banco de dados** —
toda a configuração vem de arquivos JSON. Feito para rodar isolado em outro
servidor.

## Requisitos

- Node.js 18+ (testado no Node 24).
- As configurações em JSON (já presentes nesta pasta):
  - `sistema.json` — ambiente global (`sandbox` | `producao`).
  - `bancos/bb.json` — endpoints públicos da API PIX v2 do BB.
  - `empresas/{slug}/empresa.json` — dados não sensíveis da empresa.
  - `empresas/{slug}/{ambiente}/config.json` — credenciais, chave PIX, webhook, certs.
  - `api-usuarios.json` — usuário/senha da API externa (por empresa).

## Instalação

```bash
npm install
cp .env.example .env
# edite o .env e troque o JWT_SECRET por um valor forte
npm start          # ou: npm run dev  (reinicia ao salvar)
```

Porta padrão: **3000** (mude com `PORT` no `.env`).

Variáveis do `.env`:

| Variável          | Descrição                                                      |
|-------------------|----------------------------------------------------------------|
| `PORT`            | Porta HTTP (default 3000).                                      |
| `JWT_SECRET`      | Segredo para assinar os JWT (HS256). **Obrigatório.**          |
| `CERT_PASSPHRASE` | (Opcional) senha do certificado mTLS (`.pfx`/`.p12`/`.pem`).   |

## Rotas

### `GET /health`
```bash
curl http://localhost:3000/health
# {"ok":true,"servico":"rotativo-pix","ambiente_global":"sandbox"}
```

### `POST /api/pix/token` — login → JWT (24h)
```bash
curl -X POST http://localhost:3000/api/pix/token \
  -H 'Content-Type: application/json' \
  -d '{"usuario":"oliveira_api","senha":"teste123"}'
```
Resposta: `{ token, tipo:"Bearer", expira_em, empresa, endpoints }`.
Senha errada → **401**.

### `POST /api/pix/cobranca` — gerar cobrança (exige JWT)
```bash
curl -X POST http://localhost:3000/api/pix/cobranca \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"valor":"1.00","descricao":"Pedido 123","api_base":"sem_mtls"}'
```
- `valor` (string, ex.: `"1.00"`), `descricao` (opcional), `txid` (opcional; se
  não vier, é gerado com 26–35 alfanuméricos).
- `api_base` (**opcional, SÓ sandbox**): `sem_mtls` ou `com_mtls`. Ignorado em
  produção (produção só tem `com_mtls`).
- A empresa vem do **JWT** (não é enviada no corpo).

Resposta: `{ ok, ambiente, api_base, txid, copia_cola, qrcode }`
(`qrcode` = data URI PNG). Sem token → **401**. Falha na API do BB → **502** com
`resposta_bb`.

### `GET /api/pix/cobranca/:txid` — consultar (exige JWT)
```bash
curl http://localhost:3000/api/pix/cobranca/COB123... \
  -H "Authorization: Bearer $TOKEN"
```

### `POST /webhook/pix/bb/:token` — webhook do BB (PÚBLICO, sem JWT)
O BB chama esta rota. O `:token` identifica a empresa/ambiente (bate com
`webhook.token` no `config.json`). Também aceita `.../:token/pix`.
- Token desconhecido → **404**.
- Se `webhook.restringe_ip = true`, valida o IP de origem contra `webhook_ips`
  do `bb.json` (sandbox `201.33.144.0/20`, produção `170.66.0.0/16`). Fora da
  faixa → **403**.
- OK → **200** `{ok:true}`. Tudo é gravado em `logs/`.

> Atrás de proxy/Nginx, garanta que o IP real chegue via `X-Forwarded-For`
> (o app usa `trust proxy`).

## Configurar uma empresa

1. Crie `empresas/{slug}/empresa.json`:
   ```json
   { "id": 2, "slug": "minhaempresa", "nome": "Minha Empresa", "banco": "bb", "ativo": true }
   ```
2. Crie `empresas/{slug}/sandbox/config.json` (e/ou `producao/config.json`) a
   partir do `config.exemplo.json`: preencha `credenciais` (app_key, client_id,
   client_secret, **basic**), `chave_pix` e um `webhook.token` único.
3. Adicione o login em `api-usuarios.json`:
   ```json
   { "minhaempresa": { "usuario": "minha_api", "senha": "SenhaForte" } }
   ```
   Aceita também `senha_hash` (bcrypt) no lugar de `senha`.

### Certificados / mTLS

- `api_base: "sem_mtls"` (Extranet, sandbox) → não precisa de certificado de cliente.
- `api_base: "com_mtls"` (api-pix; **obrigatório em produção**) → coloque o
  certificado de cliente em `empresas/{slug}/{ambiente}/certs/cliente.pem`
  (cert + chave privada no mesmo PEM; também aceita `.pfx`/`.p12` com
  `CERT_PASSPHRASE`). A cadeia pública do BB vai em `certs/ca.pem`.
- `ignorar_tls: true` → **só sandbox** (Extranet usa CA interna). Em produção use `false`.

## Rodar em outro servidor (passo a passo)

1. Copie a pasta `rotativo-pix/` para o servidor (sem `node_modules`).
2. Leve os arquivos **não versionados** com segurança (não estão no git):
   `api-usuarios.json`, cada `empresas/**/config.json` e os certificados
   (`certs/*.pem` / `.pfx`).
3. Instale o Node 18+ e rode `npm install --omit=dev` (ou `npm install`).
4. `cp .env.example .env` e defina um `JWT_SECRET` forte + a `PORT` desejada.
5. Ajuste `sistema.json` para `sandbox` ou `producao`.
6. Suba com um gerenciador de processo (ex.: `pm2 start index.js --name rotativo-pix`
   ou um `systemd` service). Teste `GET /health`.
7. Coloque atrás de um proxy HTTPS (Nginx) e libere no BB a URL pública do
   webhook: `https://SEU_HOST/webhook/pix/bb/{token}`.

## Segurança

- `.env`, `api-usuarios.json`, `**/config.json`, `logs/` e certificados estão no
  `.gitignore` — **não** vão para o repositório.
- Segredos (Basic, Bearer, app_key, senhas) são **mascarados** nos logs.
