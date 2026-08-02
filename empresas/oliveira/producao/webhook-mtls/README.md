# Webhook mTLS — PRODUÇÃO (oliveira)

Gateway nginx que fica **na frente** do webhook PIX e faz o **mTLS** (valida que
quem chama é o Banco do Brasil de **produção**).

- Porta local: **9443** (sandbox usa 8443 — dá pra rodar os dois juntos).
- Container: `webhook-mtls-producao`.

## Certificados (`certs/`)
| Arquivo | O que é |
|---|---|
| `server.crt` / `server.key` | HTTPS **real** do seu domínio de webhook |
| `bb-ca.pem` | cadeia **real de produção** do BB (para validar o cert do BB) |

> `bb-ca.pem` é a mesma cadeia do BB que já está em `../certs/ca.pem`.
> Copie: `cp ../certs/ca.pem certs/bb-ca.pem`
>
> **Não** existe `cliente.pem` aqui — esse é do lado de *gerar* PIX.

## Produção (obrigatório)
1. `server.crt`/`server.key` = cert **real** do seu domínio (Let's Encrypt). Nada de self-signed.
2. `bb-ca.pem` = cadeia **real de produção** do BB.
3. No `nginx/default.conf`, comente o bloco de teste e descomente o
   `proxy_pass https://SEU-APP-PROD...` apontando pro seu app.
4. Registre no BB a URL pública: `https://SEU-DOMINIO/webhook/pix/bb/{token}`.

## Rodar
```bash
docker compose up -d      # sobe na porta 9443
docker compose down
```
