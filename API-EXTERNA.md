# API externa de PIX (JWT)

API para integradores **de fora** gerarem PIX. Cada empresa tem **usuário/senha**
próprios, faz login e recebe um **JWT válido por 24h**, usado nos endpoints.

> O **webhook do BB NÃO** passa por aqui — o BB chama a rota pública direto
> (`/webhook/pix/bb/{token}`), pois não envia JWT.

## Usuários (por empresa)

Ficam em `rotativo-pix/api-usuarios.json` (**não versionado**). A senha fica em
**texto** — edite direto no arquivo quando quiser:

```json
{
  "oliveira": { "usuario": "oliveira_api", "senha": "MinhaSenha" }
}
```

Ou use o comando (também grava em texto):
```bash
php artisan pix:api-user oliveira oliveira_api "MinhaSenha"
```

> A senha em texto é possível porque o arquivo é **local e não versionado**. Se
> preferir mais segurança, use o campo `senha_hash` (bcrypt) no lugar de `senha`.

## 1) Login → JWT

```
POST /api/pix/token
Content-Type: application/json

{ "usuario": "oliveira_api", "senha": "SenhaForte#2026" }
```

Resposta:
```json
{
  "token": "eyJhbGci...",
  "tipo": "Bearer",
  "expira_em": "2026-08-03T00:16:34-03:00",
  "empresa": "oliveira",
  "endpoints": { "gerar_cobranca": {...}, "consultar_cobranca": {...} }
}
```

Use o token em todas as chamadas seguintes: `Authorization: Bearer {token}`.

## 2) Gerar cobrança (QR)

```
POST /api/pix/cobranca
Authorization: Bearer {token}
Content-Type: application/json

{ "valor": "1.00", "descricao": "Pedido 123", "txid": "opcional", "api_base": "sem_mtls" }
```

- `api_base` (**opcional, SÓ sandbox**): `sem_mtls` (Extranet, sem certificado) ou
  `com_mtls` (api-pix, exige o certificado). Em produção é ignorado (sempre com mTLS).

Resposta:
```json
{ "ok": true, "ambiente": "sandbox", "api_base": "sem_mtls", "txid": "...", "copia_cola": "000201...", "qrcode": "data:image/svg+xml;base64,..." }
```

## 3) Consultar cobrança

```
GET /api/pix/cobranca/{txid}
Authorization: Bearer {token}
```

## Observações

- O **ambiente** (sandbox/produção) segue o toggle global do sistema.
- As **credenciais/certificados** do PIX vêm de `rotativo-pix/empresas/{slug}/{ambiente}/`.
- JWT expira em **24h** — faça login de novo depois disso (HTTP 401 = token ausente/expirado).
- Em **produção** a geração exige o certificado mTLS (A1) registrado no BB.
