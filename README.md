# rotativo-pix — configuração do PIX por empresa

Config **editável em JSON** do PIX do Banco do Brasil, **por empresa** e **por
ambiente** (sandbox/produção). Cada empresa tem credenciais próprias, chave PIX,
webhook e certificados próprios.

> ⚠️ **Segurança:** este repositório tem remote no GitHub. **NUNCA** versione
> credenciais nem certificados. O `.gitignore` já bloqueia `config.json`,
> `*.pem/*.pfx/*.p12/*.key/*.cer`. Versione só os `*.exemplo.json` e este README.

## Estrutura de pastas (padrão)

```
rotativo-pix/
├── bancos/
│   └── bb.json                     # endpoints + recursos do BB (público, versionado)
└── empresas/
    └── {slug}/                     # uma pasta por empresa (slug minúsculo)
        ├── empresa.json            # id, slug, nome, banco (não sensível)
        ├── sandbox/
        │   ├── config.exemplo.json # TEMPLATE (versionado)
        │   ├── config.json         # REAL (IGNORADO — credenciais)
        │   └── certs/
        │       ├── LEIA-ME.txt     # instruções (versionado)
        │       ├── ca.pem          # cadeia do BB (IGNORADO)
        │       └── cliente.pem     # SEU cert mTLS (IGNORADO — chave privada)
        └── producao/
            └── (mesmo formato)
```

## Padrão de NOMES (importante)

- **Pasta da empresa:** `empresas/{slug}` — slug em minúsculo, sem espaço/acento (ex.: `oliveira`).
- **Ambiente:** exatamente `sandbox` ou `producao`.
- **Config real:** sempre `config.json` (copie de `config.exemplo.json`).
- **Certificados:** dentro de `certs/` — `ca.pem` (cadeia do BB) e `cliente.pem` (seu cert mTLS).
- **Campos de credencial (sempre esses nomes):**
  `app_key`, `client_id`, `client_secret`, `basic`, `registration_access_token`, `chave_pix`.

## Cada empresa tem URL própria de webhook e de PIX

- **Gerar PIX (saída):** a base sai de `bancos/bb.json` conforme `api_base`
  (`sem_mtls` = Extranet HML; `com_mtls` = api-pix). O `txid`/cobrança é por empresa.
- **Webhook (entrada):** URL **única por empresa e ambiente** →
  `https://SEU-DOMINIO/webhook/pix/bb/{token}`. O `token` fica no `config.json`
  de cada ambiente (troque por um valor único).

## Como configurar uma empresa

1. Duplique a pasta `empresas/oliveira` → `empresas/{nova-empresa}` e ajuste `empresa.json`.
2. Em cada ambiente, copie `config.exemplo.json` → `config.json` e preencha as credenciais.
3. Defina um `webhook.token` único.
4. Coloque os certificados em `certs/` (veja `LEIA-ME.txt`).
5. Escolha o `api_base`:
   - **sandbox:** `sem_mtls` (não precisa de certificado) — recomendado para testar.
   - **produção:** `com_mtls` (exige `cliente.pem` A1 registrado no BB).

## Campos do config.json

| Campo | O que é |
|---|---|
| `ambiente` | `sandbox` ou `producao` |
| `ativo` | liga/desliga o PIX desta empresa/ambiente |
| `api_base` | `sem_mtls` ou `com_mtls` (chave em `bancos/bb.json`) |
| `ignorar_tls` | `true` só em sandbox (Extranet usa CA interna) |
| `credenciais.*` | app_key, client_id, client_secret, basic, registration_access_token |
| `chave_pix` | chave PIX de recebimento da empresa |
| `webhook.token` | token único da URL de webhook |
| `webhook.restringe_ip` | só aceita webhook do range do BB |
| `certificados.cliente/ca` | caminhos (relativos) dos certificados |

## Ambientes / mTLS (resumo)

- **sandbox `sem_mtls`** → só credenciais + chave. **Sem certificado.** ✅ testar aqui.
- **sandbox `com_mtls`** e **produção** → exigem `cliente.pem` **registrado no BB** (A1/e-CNPJ).
