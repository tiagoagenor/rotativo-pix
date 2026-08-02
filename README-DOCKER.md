# Rodar o sistema completo em Docker

Um `nginx` (443) na frente do serviço `app` (Node, 3000). **mTLS exigido só na
rota do webhook** — o resto (API JWT, `/health`) passa sem mTLS.

```
                ┌──────────── nginx (443) ────────────┐
 Integrador ──► │ /api/pix/*   → SEM mTLS              │ ──► app Node (3000)
 (JWT)          │ /health      → SEM mTLS              │
 Banco Brasil ─►│ /webhook/... → EXIGE mTLS (cert BB)  │ ──► app Node (3000)
                └─────────────────────────────────────┘
```

## Subir
```bash
cp .env.example .env            # defina JWT_SECRET
./nginx/gerar-certs-teste.sh    # certs de TESTE (em produção use os reais)
docker compose up -d --build
```
- App: interno em `app:3000` (não exposto).
- nginx: `80` (redireciona) e `443`.

## Testar
```bash
C=nginx/certs
# sistema geral (sem mTLS):
curl -sk https://localhost/health
curl -sk -X POST https://localhost/api/pix/sandbox/token \
  -H "Content-Type: application/json" -d '{"usuario":"oliveira_sandbox","senha":"sandbox123"}'

# webhook (mTLS):
curl -sk                         -X POST https://localhost/webhook/pix/bb/TOKEN   # 403 (sem cert)
curl -sk --cert $C/client-bad.pem -X POST https://localhost/webhook/pix/bb/TOKEN  # 400 (cert inválido)
curl -sk --cert $C/client-ok.pem  -X POST https://localhost/webhook/pix/bb/SEU_TOKEN -d '{"pix":[]}'  # passa o mTLS
```

## O que entra por volume (não fica na imagem)
- `bancos/`, `empresas/`, `sistema.json`, `api-usuarios.json` (config, read-only)
- `logs/` (gravável)
- `nginx/certs/` (server.crt/key + bb-ca.pem)
- `.env` (JWT_SECRET)

## Produção (deploy)

### 1) DNS
Aponte o domínio para o servidor (registro **A**):
```
ideia99.com   A   145.223.92.79
```

### 2) Subir a stack (com cert de teste, pra o nginx já responder na :80)
```bash
cp .env.example .env             # defina JWT_SECRET
./nginx/gerar-certs-teste.sh     # cert temporário (autoassinado)
docker compose up -d --build
```

### 3) Emitir o certificado real (Let's Encrypt)
Com o DNS já apontando e o nginx no ar:
```bash
./nginx/obter-letsencrypt.sh ideia99.com  seu-email@dominio.com
```
O script usa o certbot (webroot em `/.well-known/acme-challenge/`), copia o cert
para `nginx/certs/server.crt` + `server.key` e recarrega o nginx.
> Renovação: rode o mesmo script periodicamente (ex.: cron semanal).

> ⚠️ **Confirme na doc do BB** se o webhook aceita cert público (Let's Encrypt) ou
> exige **ICP-Brasil**. Se exigir ICP, troque só o `server.crt`/`server.key` por um
> cert de servidor ICP-Brasil — o resto da config não muda.

### 4) CA do BB (validação do webhook mTLS)
`nginx/certs/bb-ca.pem` = cadeia(s) real(is) do BB. Sandbox + produção no mesmo nginx:
```bash
cat empresas/oliveira/sandbox/certs/ca.pem \
    empresas/oliveira/producao/certs/ca.pem > nginx/certs/bb-ca.pem
docker compose exec nginx nginx -s reload
```

### 5) Registrar o webhook no BB
URL pública (o token identifica o ambiente — sandbox × produção):
```
https://ideia99.com/webhook/pix/bb/{token_sandbox}
https://ideia99.com/webhook/pix/bb/{token_producao}
```

## Observação
Este compose (raiz) **substitui** os gateways `webhook-mtls/` por-ambiente: aqui o
nginx já faz o mTLS do webhook **e** serve o resto do sistema, tudo num ponto só.
Os `empresas/*/webhook-mtls/` continuam como alternativa (deploy separado por
subdomínio), mas não são necessários se você usar este compose.
