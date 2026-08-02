#!/usr/bin/env bash
# =============================================================================
# Gera certificados de TESTE para o nginx do sistema completo.
# NADA é real do BB — tudo self-signed / CA de teste. Idempotente (--force recria).
#
# Gera em ./certs/:
#   server.crt / server.key  -> HTTPS do servidor (self-signed, use -k no curl)
#   test-ca.crt / test-ca.key-> CA de teste (simula a "CA do BB")
#   bb-ca.pem                -> cópia da CA de teste (no teste, "CA do BB" = essa)
#   client-ok.pem            -> cliente ASSINADO pela CA -> webhook deve ACEITAR
#   client-bad.pem           -> cliente self-signed      -> webhook deve REJEITAR
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p certs
cd certs

FORCE=0; [[ "${1:-}" == "--force" ]] && FORCE=1
gen() { local s="$1"; shift; local d="$1"; shift; if [[ $FORCE -eq 1 || ! -f "$s" ]]; then echo ">> $d"; "$@"; else echo "== já existe: $d"; fi; }

mk_ca() {
  openssl genrsa -out test-ca.key 4096 2>/dev/null
  openssl req -x509 -new -nodes -key test-ca.key -sha256 -days 825 \
    -subj "/C=BR/O=CA de Teste/CN=Test Root CA (NAO E O BB)" -out test-ca.crt 2>/dev/null
  cp test-ca.crt bb-ca.pem
}
gen test-ca.crt "CA de teste + bb-ca.pem" mk_ca

mk_server() {
  openssl genrsa -out server.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key server.key -sha256 -days 825 \
    -subj "/C=BR/O=Rotativo PIX/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -out server.crt 2>/dev/null
}
gen server.crt "certificado do servidor (self-signed)" mk_server

mk_ok() {
  openssl genrsa -out client-ok.key 2048 2>/dev/null
  openssl req -new -key client-ok.key -subj "/C=BR/O=Banco do Brasil (SIMULADO)/CN=webhook-ok" -out client-ok.csr 2>/dev/null
  openssl x509 -req -in client-ok.csr -CA test-ca.crt -CAkey test-ca.key -CAcreateserial -days 825 -sha256 -out client-ok.crt 2>/dev/null
  cat client-ok.crt client-ok.key > client-ok.pem; rm -f client-ok.csr
}
gen client-ok.crt "cliente VÁLIDO (assinado pela CA)" mk_ok

mk_bad() {
  openssl genrsa -out client-bad.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key client-bad.key -sha256 -days 825 -subj "/C=BR/O=Atacante/CN=webhook-bad" -out client-bad.crt 2>/dev/null
  cat client-bad.crt client-bad.key > client-bad.pem
}
gen client-bad.crt "cliente INVÁLIDO (self-signed)" mk_bad

chmod 600 ./*.key 2>/dev/null || true
echo; echo "OK. Certs de teste em: $(pwd)"; ls -1 *.crt *.pem 2>/dev/null | sort
