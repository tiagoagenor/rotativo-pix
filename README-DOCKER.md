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
cp .env.example .env            # defina JWT_SECRET  (OBRIGATÓRIO antes do up)
./nginx/gerar-certs-teste.sh    # certs de TESTE (em produção use os reais)
docker compose up -d --build
```
> ⚠️ O `.env` é montado como **volume** (`./.env:/app/.env:ro`). Ele **precisa
> existir antes** do `docker compose up` — se faltar, o Docker cria uma *pasta*
> `.env` por engano. Sempre rode o `cp .env.example .env` primeiro.

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
A config, os segredos e os logs ficam **fora do projeto**, na pasta irmã
`../cache` (no servidor: `/root/rotativo/cache`). Assim você dá `git pull` /
rebuilda o projeto sem tocar nos dados. O `bootstrap-cache.sh` monta essa pasta.

- `../cache/.env` (JWT_SECRET)
- `../cache/bancos/`, `../cache/empresas/`, `../cache/sistema.json`,
  `../cache/api-usuarios.json` (config real, read-only)
- `../cache/logs/` (gravável)
- `nginx/certs/` (server.crt/key + bb-ca.pem) — continua no projeto

## Produção (deploy)

### 1) DNS
Aponte o domínio para o servidor (registro **A**):
```
ideia99.com   A   145.223.92.79
```

### 2) Montar a pasta de dados/segredos (../cache) e editar
```bash
./bootstrap-cache.sh             # cria /root/rotativo/cache com .env + config
```
Edite os arquivos reais (fora do projeto):
```bash
nano ../cache/.env                                   # JWT_SECRET
nano ../cache/empresas/oliveira/sandbox/config.json  # credenciais BB
nano ../cache/api-usuarios.json                      # usuarios/senhas
```
Copie os certs do BB (do seu PC) para o cache:
```bash
scp .../sandbox/certs/cliente.pem .../sandbox/certs/ca.pem \
  root@145.223.92.79:/root/rotativo/cache/empresas/oliveira/sandbox/certs/
```

### 3) Subir a stack (com cert de teste, pra o nginx já responder na :80)
```bash
./nginx/gerar-certs-teste.sh     # cert temporário (autoassinado)
docker compose up -d --build
```

### 4) Emitir o certificado real (Let's Encrypt)
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

### 5) CA do BB (validação do webhook mTLS)
`nginx/certs/bb-ca.pem` = cadeia(s) real(is) do BB. Sandbox + produção no mesmo nginx
(os certs agora ficam no cache):
```bash
cat ../cache/empresas/oliveira/sandbox/certs/ca.pem \
    ../cache/empresas/oliveira/producao/certs/ca.pem > nginx/certs/bb-ca.pem
docker compose exec nginx nginx -s reload
```

### 6) Registrar o webhook no BB
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
