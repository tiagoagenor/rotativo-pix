#!/usr/bin/env bash
# =============================================================================
# Monta a pasta de dados/segredos FORA do projeto, em ../cache.
#   Projeto: /root/rotativo/rotativo-pix  ->  cache: /root/rotativo/cache
#
# O docker-compose monta ../cache como volumes (config real, .env e logs).
# Assim você pode dar 'git pull' / rebuildar o projeto sem tocar nos segredos.
#
# É SEGURO rodar de novo: não sobrescreve arquivos já existentes no cache.
# Uso:  ./bootstrap-cache.sh
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"          # pasta do projeto
CACHE="../cache"

mkdir -p "$CACHE/logs" "$CACHE/empresas"

# 1) Config NÃO-secreta (copia do repo; -n = não sobrescreve)
cp -rn bancos "$CACHE/" 2>/dev/null || true
[ -f "$CACHE/sistema.json" ] || cp sistema.json "$CACHE/sistema.json"

# 2) Estrutura de empresas (traz exemplos, LEIA-ME e pastas de certs)
cp -rn empresas/. "$CACHE/empresas/" 2>/dev/null || true

# 3) Arquivos que VOCÊ deve editar com valores reais (só cria se faltar)
if [ ! -f "$CACHE/.env" ]; then
  echo "PORT=3000" > "$CACHE/.env"
  echo "JWT_SECRET=$(openssl rand -hex 24)" >> "$CACHE/.env"
  echo ">> criei $CACHE/.env (JWT_SECRET aleatório)"
fi
[ -f "$CACHE/api-usuarios.json" ] || cp api-usuarios.exemplo.json "$CACHE/api-usuarios.json"
for amb in sandbox producao; do
  d="$CACHE/empresas/oliveira/$amb"
  [ -d "$d" ] && [ ! -f "$d/config.json" ] && cp "$d/config.exemplo.json" "$d/config.json" 2>/dev/null || true
done

echo
echo "OK. Cache pronto em: $(cd "$CACHE" && pwd)"
echo
echo "AGORA edite com os valores reais:"
echo "  $CACHE/.env                                   (JWT_SECRET)"
echo "  $CACHE/empresas/oliveira/sandbox/config.json  (credenciais BB)"
echo "  $CACHE/empresas/oliveira/producao/config.json"
echo "  $CACHE/api-usuarios.json                      (usuarios/senhas da API)"
echo "E copie os certificados do BB para:"
echo "  $CACHE/empresas/oliveira/<ambiente>/certs/  (cliente.pem, ca.pem)"
