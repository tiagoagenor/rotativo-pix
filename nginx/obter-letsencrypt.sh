#!/usr/bin/env bash
# =============================================================================
# Emite (ou renova) o certificado Let's Encrypt do domínio e aplica no nginx.
#
# PRÉ-REQUISITOS (no servidor):
#   1) DNS do domínio apontando para este servidor (registro A).
#   2) Os containers no ar: docker compose up -d   (nginx respondendo na :80).
#
# Uso:
#   ./nginx/obter-letsencrypt.sh ideia99.com  seu-email@dominio.com
#
# O nginx sobe com o server.crt de teste (autoassinado); este script troca pelo
# certificado REAL do Let's Encrypt e recarrega o nginx.
# =============================================================================
set -euo pipefail

DOMINIO="${1:-ideia99.com}"
EMAIL="${2:-}"
[[ -z "$EMAIL" ]] && { echo "Uso: $0 <dominio> <email>"; exit 1; }

# raiz do projeto (onde está o docker-compose.yml)
cd "$(dirname "$0")/.."

mkdir -p nginx/acme-webroot nginx/letsencrypt

echo ">> Emitindo/renovando certificado para: $DOMINIO"
docker run --rm \
  -v "$PWD/nginx/letsencrypt:/etc/letsencrypt" \
  -v "$PWD/nginx/acme-webroot:/var/www/certbot" \
  certbot/certbot certonly --webroot -w /var/www/certbot \
    -d "$DOMINIO" \
    --email "$EMAIL" --agree-tos --no-eff-email --non-interactive

echo ">> Aplicando o certificado no nginx"
cp "nginx/letsencrypt/live/$DOMINIO/fullchain.pem" nginx/certs/server.crt
cp "nginx/letsencrypt/live/$DOMINIO/privkey.pem"  nginx/certs/server.key

echo ">> Recarregando o nginx"
docker compose exec nginx nginx -s reload

echo
echo "OK — Let's Encrypt aplicado para $DOMINIO."
echo "Renovação: rode este mesmo script periodicamente (ex.: cron semanal),"
echo "ou 'docker run ... certbot renew' + copiar de novo os .pem e recarregar."
