#!/usr/bin/env bash
# =============================================================================
# enviar-cache.sh
# -----------------------------------------------------------------------------
# Envia a CONFIG/SEGREDOS locais para o cache do servidor (via rsync, ou scp
# como fallback). RODA NO SEU COMPUTADOR — não no servidor.
#
# Origem (esta pasta do projeto):  .env, bancos/, empresas/, sistema.json,
#                                  api-usuarios.json
# Destino (servidor):              /root/rotativo/cache/
#
# Uso:
#   ./enviar-cache.sh                                   # usa os padrões abaixo
#   ./enviar-cache.sh root@145.223.92.79 /root/rotativo/cache
#
# Observação: sobrescreve no servidor os arquivos de mesmo nome (é isso que
# você quer ao "empurrar" a config). Não apaga arquivos que só existam lá.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"          # pasta do projeto = origem dos arquivos

SERVIDOR="${1:-root@145.223.92.79}"
DEST="${2:-/root/rotativo/cache}"

# Itens que compõem o cache (os mesmos volumes do docker-compose).
ITENS=(.env bancos empresas sistema.json api-usuarios.json)

echo ">> Servidor : $SERVIDOR"
echo ">> Destino  : $DEST"
echo

echo ">> Criando a estrutura no servidor"
ssh "$SERVIDOR" "mkdir -p '$DEST/logs'"

for item in "${ITENS[@]}"; do
  if [ ! -e "$item" ]; then
    echo "== pulando (não existe localmente): $item"
    continue
  fi
  echo ">> enviando: $item"
  if command -v rsync >/dev/null 2>&1; then
    rsync -az "$item" "$SERVIDOR:$DEST/"
  else
    scp -r "$item" "$SERVIDOR:$DEST/"
  fi
done

echo
echo "OK — cache enviado para $SERVIDOR:$DEST"
echo "No servidor: cd /root/rotativo/rotativo-pix && docker compose up -d --build"
