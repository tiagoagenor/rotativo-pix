#!/usr/bin/env bash
# =============================================================================
# gerar-certs-teste.sh
# -----------------------------------------------------------------------------
# Gera certificados de TESTE para provar o mecanismo de mTLS do gateway nginx.
# NADA aqui é real do Banco do Brasil — é tudo self-signed / CA de teste.
# Idempotente: só (re)gera o que estiver faltando. Use --force para recriar tudo.
#
# Arquivos gerados em ./certs/:
#   server.crt / server.key  -> certificado do SEU servidor (self-signed p/ teste)
#   test-ca.crt / test-ca.key-> CA de teste (simula a "CA do BB")
#   bb-ca.pem                -> cópia da CA de teste (no teste, "CA do BB" = CA de teste)
#   client-ok.crt/.key/.pem  -> cliente ASSINADO pela CA de teste  -> deve ser ACEITO
#   client-bad.crt/.key/.pem -> cliente self-signed (NAO assinado) -> deve ser REJEITADO
# =============================================================================
set -euo pipefail

cd "$(dirname "$0")/certs"

FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

gen() {
  # gen <arquivo-sentinela> <descricao> ; roda o bloco (stdin) se faltar ou --force
  local sentinela="$1"; shift
  local desc="$1"; shift
  if [[ $FORCE -eq 1 || ! -f "$sentinela" ]]; then
    echo ">> gerando: $desc"
    "$@"
  else
    echo "== já existe: $desc ($sentinela)"
  fi
}

# --- 1) CA de teste (simula a cadeia do BB) ---------------------------------
mk_ca() {
  openssl genrsa -out test-ca.key 4096 2>/dev/null
  openssl req -x509 -new -nodes -key test-ca.key -sha256 -days 825 \
    -subj "/C=BR/O=CA de Teste Webhook/CN=Test Root CA (NAO E O BB)" \
    -out test-ca.crt 2>/dev/null
  cp test-ca.crt bb-ca.pem   # no teste: "CA do BB" == CA de teste
}
gen test-ca.crt "CA de teste (test-ca) + bb-ca.pem" mk_ca

# --- 2) Certificado do SERVIDOR (self-signed p/ teste) ----------------------
mk_server() {
  openssl genrsa -out server.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key server.key -sha256 -days 825 \
    -subj "/C=BR/O=Rotativo PIX/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
    -out server.crt 2>/dev/null
}
gen server.crt "certificado do servidor (self-signed)" mk_server

# --- 3) Cliente VÁLIDO: assinado pela CA de teste ---------------------------
mk_client_ok() {
  openssl genrsa -out client-ok.key 2048 2>/dev/null
  openssl req -new -key client-ok.key \
    -subj "/C=BR/O=Banco do Brasil (SIMULADO)/CN=webhook-client-ok" \
    -out client-ok.csr 2>/dev/null
  openssl x509 -req -in client-ok.csr -CA test-ca.crt -CAkey test-ca.key \
    -CAcreateserial -days 825 -sha256 -out client-ok.crt 2>/dev/null
  # .pem = cert + chave juntos (conveniência p/ curl --cert)
  cat client-ok.crt client-ok.key > client-ok.pem
  rm -f client-ok.csr
}
gen client-ok.crt "cliente VÁLIDO (assinado pela CA de teste)" mk_client_ok

# --- 4) Cliente INVÁLIDO: self-signed, NÃO assinado pela CA -----------------
mk_client_bad() {
  openssl genrsa -out client-bad.key 2048 2>/dev/null
  openssl req -x509 -new -nodes -key client-bad.key -sha256 -days 825 \
    -subj "/C=BR/O=Atacante Aleatorio/CN=webhook-client-bad" \
    -out client-bad.crt 2>/dev/null
  cat client-bad.crt client-bad.key > client-bad.pem
}
gen client-bad.crt "cliente INVÁLIDO (self-signed)" mk_client_bad

chmod 600 ./*.key 2>/dev/null || true

echo
echo "OK. Certificados de teste em: $(pwd)"
ls -1 *.crt *.key *.pem 2>/dev/null | sort
