#!/usr/bin/env bash
# =============================================================================
# webhook-acesso.sh — abre/fecha o acesso ao webhook (filtro de IP), na hora.
#
#   on  = ABERTO  -> qualquer IP entra (só precisa do token na URL)
#   off = FECHADO -> só o range do BB (webhook.ips) entra
#
# O app lê o config ao vivo: NÃO precisa reiniciar nada. Efeito é imediato.
#
# Uso:
#   ./webhook-acesso.sh on            # abre produção (padrão)
#   ./webhook-acesso.sh off           # fecha produção
#   ./webhook-acesso.sh on sandbox    # abre sandbox
#   ./webhook-acesso.sh status        # mostra o estado dos dois ambientes
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
ACAO="${1:-status}"
AMB="${2:-producao}"

cfg() { echo "../cache/empresas/oliveira/$1/config.json"; }

setflag() {
  local arquivo="$1" val="$2"
  python3 - "$arquivo" "$val" <<'PY'
import json,sys
p, val = sys.argv[1], (sys.argv[2] == "true")
c = json.load(open(p))
c["webhook"]["restringe_ip"] = val
json.dump(c, open(p, "w"), ensure_ascii=False, indent=2)
estado = "FECHADO (só range do BB)" if val else "ABERTO (qualquer IP + token)"
print(f"  {p}\n  -> {estado}")
PY
}

case "$ACAO" in
  on)  echo ">> ABRINDO webhook ($AMB)";  setflag "$(cfg "$AMB")" false ;;
  off) echo ">> FECHANDO webhook ($AMB)"; setflag "$(cfg "$AMB")" true  ;;
  status)
    for a in sandbox producao; do
      python3 - "$(cfg "$a")" "$a" <<'PY'
import json,sys
p,amb=sys.argv[1],sys.argv[2]
try:
    w=json.load(open(p))["webhook"]
    est="FECHADO (range BB)" if w.get("restringe_ip") else "ABERTO (qualquer IP)"
    print(f"  {amb:9} -> {est} | ips={w.get('ips')} | token={w.get('token')}")
except FileNotFoundError:
    print(f"  {amb:9} -> (sem config)")
PY
    done ;;
  *) echo "Uso: $0 <on|off|status> [sandbox|producao]"; exit 1 ;;
esac
