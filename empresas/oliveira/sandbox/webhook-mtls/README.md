# Webhook mTLS — SANDBOX (oliveira)

Gateway nginx que fica **na frente** do webhook PIX e faz o **mTLS** (valida que
quem chama é o Banco do Brasil de **homologação**).

- Porta local: **8443** (para não colidir com produção, que usa 9443).
- Container: `webhook-mtls-sandbox`.

## Certificados (`certs/`)
| Arquivo | O que é |
|---|---|
| `server.crt` / `server.key` | HTTPS do **seu** domínio de webhook |
| `bb-ca.pem` | cadeia do **BB de homologação** (para validar o cert do BB) |

> `bb-ca.pem` é a mesma cadeia do BB que já está em `../certs/ca.pem`.
> Copie: `cp ../certs/ca.pem certs/bb-ca.pem`
>
> **Não** existe `cliente.pem` aqui — esse é do lado de *gerar* PIX.

## Testar local
```bash
./gerar-certs-teste.sh          # cria certs de teste (server + CA + cliente simulado)
docker compose up -d
# deve ACEITAR (cliente válido):
curl -k --cert certs/client-ok.pem  https://localhost:8443/webhook/pix/bb/TESTE
# deve REJEITAR (sem cert / cert inválido):
curl -k                              https://localhost:8443/webhook/pix/bb/TESTE
curl -k --cert certs/client-bad.pem https://localhost:8443/webhook/pix/bb/TESTE
docker compose down
```

## Produção
1. Troque `server.crt`/`server.key` pelo cert real do seu domínio.
2. Troque `bb-ca.pem` pela cadeia real de **homologação** do BB (`../certs/ca.pem`).
3. No `nginx/default.conf`, comente o bloco de teste (`return 200 ...`) e
   descomente o `proxy_pass https://SEU-APP-SANDBOX...` apontando pro seu app.
4. Registre no BB a URL pública: `https://SEU-DOMINIO/webhook/pix/bb/{token}`.
