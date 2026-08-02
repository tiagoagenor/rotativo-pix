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

## Produção
1. `nginx/certs/server.crt` + `server.key` = cert real do seu domínio (Let's Encrypt).
2. `nginx/certs/bb-ca.pem` = cadeia(s) real(is) do BB. Para sandbox + prod no mesmo
   nginx, concatene as duas:
   ```bash
   cat empresas/oliveira/sandbox/certs/ca.pem \
       empresas/oliveira/producao/certs/ca.pem > nginx/certs/bb-ca.pem
   ```
3. Registre no BB a URL pública do webhook: `https://SEU-DOMINIO/webhook/pix/bb/{token}`
   (o token identifica o ambiente — sandbox × produção).

## Observação
Este compose (raiz) **substitui** os gateways `webhook-mtls/` por-ambiente: aqui o
nginx já faz o mTLS do webhook **e** serve o resto do sistema, tudo num ponto só.
Os `empresas/*/webhook-mtls/` continuam como alternativa (deploy separado por
subdomínio), mas não são necessários se você usar este compose.
