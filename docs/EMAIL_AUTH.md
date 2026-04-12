# EMAIL_AUTH.md — OAuth Setup Wizard (V2, direct XOAUTH2)

> Levantamento de requisitos para substituir `/curve/config` por um wizard
> passo-a-passo que autoriza o acesso ao email de cada utilizador directamente
> a partir do Node backend, sem proxy intermédio, eliminando qualquer
> necessidade de acesso ao terminal.
>
> **V2 vs V1:** a implementação original (Caminho B com `email-oauth2-proxy`
> Python + ficheiro INI + systemd) está preservada em
> [`EMAIL_AUTH_V1_PROXY.md`](./EMAIL_AUTH_V1_PROXY.md) para referência
> histórica. Este documento descreve a arquitectura alvo: `imapflow` fala
> XOAUTH2 directamente contra `outlook.office365.com:993`, e `@azure/msal-node`
> gere o lifecycle de tokens com cache persistido em MongoDB.

---

## 1. Contexto e Problema

### O que mudou nos providers de email

A Microsoft desactivou basic authentication (login com password directa) para
IMAP/POP em Outubro 2022 para tenants empresariais e em Setembro 2024 para
contas pessoais (outlook.com, hotmail.com, live.com). A Google fez o mesmo
para contas sem 2FA. O único mecanismo suportado é **OAuth 2.0 (XOAUTH2)**,
que exige um application registration, um consent flow interactivo, e gestão
contínua de access/refresh tokens.

### Como o Embers resolvia

O pipeline original usava `offlineimap` (cliente IMAP) ligado a
`email-oauth2-proxy` (bridge local Python), que traduzia plain IMAP LOGIN em
XOAUTH2 contra os servidores Microsoft. O setup era inteiramente por
terminal: editar `emailproxy.config`, correr o proxy interactivamente para
obter o consent, depois instalar como serviço systemd. Funcionou para um
user, mas:

- Quando o refresh token expirava, o proxy retornava zero emails
  **silenciosamente** — sem erros no log
- Re-autorização exigia SSH ao servidor + interacção com prompt interactivo
- Adicionar um segundo user significava editar ficheiros de configuração à mão
- O proxy precisava de systemd, venv Python, sudoers para restart, e um
  ficheiro INI partilhado entre processos com locking manual

### O que o Curve Sync precisa

Um onboarding **web-only** onde o utilizador:

1. Nunca toca num terminal
2. Nunca vê as palavras "IMAP", "OAuth", ou "config file"
3. Autoriza o acesso ao email num wizard guiado com linguagem simples
4. Pode re-autorizar se os tokens expirarem, pela mesma via

### Porque deixamos cair o proxy

O `imapflow` (que o Curve Sync já usa em `server/src/services/imapReader.js`)
suporta XOAUTH2 nativamente via `auth: { user, accessToken }`. O
`@azure/msal-node` trata de todo o lifecycle OAuth (device code, authorization
code, automatic refresh) e oferece um `ICachePlugin` interface para persistir
tokens em qualquer backing store — no nosso caso, MongoDB. A combinação
elimina o proxy por completo:

- Sem processo Python, sem venv, sem systemd unit
- Sem ficheiro INI partilhado, sem `flock`, sem restart após cada mudança
- Sem sudoers entries
- Sem três fontes de verdade (DB + config file + tokens em memória do proxy)
- Tokens vivem num único sítio: `CurveConfig.oauth_token_cache`, encriptado
  com o mesmo AES-256-GCM que já protege `CurveConfig.imap_password`

O backend faz tudo em processo Node: inicia o fluxo OAuth, guarda tokens,
refresh automático, fala IMAP directamente. Uma dependência Python a menos,
um modo de falha silenciosa a menos.

---

## 2. Arquitectura Geral

### 2.1 Topologia legacy (V1, proxy-based)

```
Curve Sync ──plain LOGIN──▶ 127.0.0.1:1993 ──XOAUTH2──▶ outlook.office365.com:993
              (imap_password                email-oauth2-proxy
               = Fernet key)                emailproxy.config
                                            (1 secção por conta,
                                             tokens encriptados com PBKDF2+Fernet)
```

- Bridge Python local traduz plain LOGIN em XOAUTH2
- Tokens vivem no ficheiro INI (`emailproxy.config`)
- `imap_password` do CurveConfig é na verdade a key de decriptação dos tokens
- Restart do systemd necessário para aplicar mudanças de config
- Documentação preservada em `EMAIL_AUTH_V1_PROXY.md`

### 2.2 Topologia alvo (V2, direct XOAUTH2)

```
┌────────────┐
│  User A    │
│ CurveConfig│────┐
│ oauth_*    │    │
└────────────┘    │
                  │    ┌──────────────┐
┌────────────┐    │    │              │
│  User B    │    ├───▶│ imapflow +   │──XOAUTH2──▶ outlook.office365.com:993
│ CurveConfig│    │    │ msal-node    │              (ou Gmail, etc)
│ oauth_*    │────┤    │ (in-process) │
└────────────┘    │    │              │
                  │    └──────┬───────┘
┌────────────┐    │           │
│  User C    │    │           │ MSAL cache plugin
│ CurveConfig│────┘           ▼
│ oauth_*    │         ┌──────────────┐
└────────────┘         │  MongoDB     │
                       │ curve_configs│
                       │ .oauth_token_│
                       │  cache       │
                       │ (AES-256-GCM)│
                       └──────────────┘
```

- Sem proxy, sem 127.0.0.1:1993, sem systemd unit, sem ficheiro INI
- `imapflow` liga directamente ao servidor IMAP do provider com TLS
- `@azure/msal-node` trata do consent flow e guarda tokens em MongoDB via
  cache plugin (`beforeCacheAccess` / `afterCacheAccess`)
- Cada `CurveConfig` é totalmente self-contained: tem tudo o que é preciso
  para reconstruir um `PublicClientApplication` e ligar ao IMAP

### 2.3 Isolamento por user

Com o proxy havia uma secção INI partilhada por email e locking global. Em
V2 cada user tem o seu próprio `CurveConfig`, o seu próprio MSAL account, e
o seu próprio token cache em DB. Não há ficheiros partilhados, não há
conflitos de escrita, não há necessidade de coordenação entre requests
concorrentes de users diferentes.

O único recurso verdadeiramente partilhado é o **app registration** no
Azure AD (`AZURE_CLIENT_ID` / `AZURE_CLIENT_SECRET` em env vars), que é
o mesmo para todos os users — é apenas a identidade da aplicação junto da
Microsoft, não tem estado por user.

### 2.4 Componentes envolvidos

- **Frontend:** wizard React em `/curve/setup` (nova página), configuração
  simplificada em `/curve/config` (pasta, intervalo, toggle)
- **Backend Express:** endpoints novos `/api/curve/oauth/*` (start, poll,
  complete, status). Nenhum endpoint de gestão de proxy.
- **`@azure/msal-node`:** lifecycle OAuth (device code grant, authorization
  code grant, silent refresh)
- **MSAL cache plugin:** `ICachePlugin` que serializa/deserializa o cache
  para `CurveConfig.oauth_token_cache` com encriptação AES-256-GCM
- **`imapflow`:** cliente IMAP com `auth: { user, accessToken }` para XOAUTH2
- **MongoDB `curve_configs`:** acrescenta os campos `oauth_provider`,
  `oauth_token_cache`, `oauth_account_id`
- **Azure AD App Registration:** single app partilhado, configurado para
  "public client flows" (DAG) e redirect URI `http://localhost` (external auth)

### 2.5 Comparação lado-a-lado

| Aspecto | V1 (proxy) | V2 (directo) |
|---------|-----------|--------------|
| Processo extra | `email-oauth2-proxy` (Python + systemd) | nenhum |
| Onde ficam os tokens | `emailproxy.config` (INI, Fernet) | `curve_configs.oauth_token_cache` (MongoDB, AES-256-GCM) |
| Refresh automático | pelo proxy, opaco | pelo MSAL, observável em logs Node |
| Aplicar nova conta | restart systemd (ou SIGHUP) | nenhuma acção — next sync usa novos tokens |
| Concorrência | `flock` no ficheiro INI | nenhuma — cada user tem o seu documento |
| Falha silenciosa conhecida | sim (refresh expirado → zero emails sem erro) | não — `acquireTokenSilent` lança erro |
| Linguagens no pipeline | Node + Python | Node |
| Dependências de sistema | venv, systemd, sudoers | zero |
| Portabilidade | precisa de Linux + systemd | corre em qualquer sítio onde o Node corre |

### 2.6 Implicações para o `imapReader.js`

A única mudança significativa no reader é no construtor:

```javascript
// server/src/services/imapReader.js (V2)
const authConfig = config.oauth_provider
  ? { user: config.imap_username, accessToken: await getOAuthToken(config) }
  : { user: config.imap_username, pass: config.imap_password };

this.client = new ImapFlow({
  host: config.imap_server,
  port: config.imap_port ?? 993,
  secure: true,
  auth: authConfig,
  logger: false,
  disableAutoIdle: true,
});
```

Tudo o resto (`fetchUnseen`, `markSeenBatch`, `classifyError`, `openFolder`)
fica inalterado. O branch `config.imap_password` continua a funcionar para
quem ainda usa App Passwords (Gmail legacy, contas sem OAuth). A mudança é
aditiva, não destrutiva.

---

## 3. OAuth directo via imapflow + MSAL

> _[Placeholder]_ Secção NOVA. Vai cobrir:
>
> - Como o `imapflow` faz XOAUTH2 nativamente (`auth: { user, accessToken }`)
> - Como o `@azure/msal-node` gere tokens (`PublicClientApplication`,
>   `acquireTokenByDeviceCode`, `acquireTokenSilent`, `acquireTokenByCode`)
> - Novos campos no `CurveConfig` (`oauth_provider`, `oauth_token_cache`,
>   `oauth_account_id`, `oauth_client_id`, `oauth_tenant_id`)
> - `getOAuthToken(config)` — helper que reconstrói o MSAL client a partir
>   do CurveConfig, tenta `acquireTokenSilent` e devolve access token
> - MSAL `ICachePlugin` adaptado a MongoDB (beforeCacheAccess/afterCacheAccess)
> - Encriptação do cache com AES-256-GCM reutilizando o helper existente
> - Snippets de código para cada peça

---

## 4. Fluxos OAuth Suportados

> _[Placeholder]_ Mantém a estrutura do V1 (DAG + external-auth + matriz
> "quando usar qual"), mas actualizado para MSAL:
>
> - DAG: `app.acquireTokenByDeviceCode({ deviceCodeCallback, scopes })` em
>   vez de POST manual ao endpoint `/devicecode`
> - External auth: `app.getAuthCodeUrl({ scopes, redirectUri })` +
>   `app.acquireTokenByCode({ code, redirectUri })`
> - Tokens persistidos automaticamente no MongoDB via cache plugin (não há
>   escrita manual em `emailproxy.config`)
> - `poll_id` deixa de ser necessário — o DAG é promise-based em MSAL

---

## 5. Wizard — Passos do Frontend

> _[Placeholder]_ Mantém 5 passos (0 boas-vindas, 1 email, 2 autorização,
> 3 verificação, 4 activar). Diferença-chave:
>
> - **Passo 3 simplificado:** o checklist fica apenas `test-connection →
>   listar pastas`. Sai: "configurar proxy", "reiniciar serviço", espera
>   de 2s. Entra: fade-in directo para o dropdown de pastas.
> - **Passos 0, 1, 2, 4:** cópia e design inalterados do V1.

---

## 6. Backend — Novos Endpoints

> _[Placeholder]_ Apenas endpoints OAuth + integração com endpoints
> existentes. **Desaparecem todos os endpoints de proxy management**
> (`/api/curve/proxy/status`, `/api/curve/proxy/accounts/*`,
> `/api/curve/proxy/restart`). Ficam:
>
> - `POST /api/curve/oauth/start` — inicia DAG ou gera authorize URL
> - `GET  /api/curve/oauth/poll` — status do DAG em curso
> - `POST /api/curve/oauth/complete` — paste-back do external-auth
> - `GET  /api/curve/oauth/status` — estado dos tokens do user (válidos?
>   próximos de expirar? precisa de re-auth?)
> - `DELETE /api/curve/oauth` — revogar tokens e limpar cache
> - Integração com `PUT /api/curve/config`, `POST /api/curve/test-connection`,
>   `POST /api/curve/sync` (inalterados)

---

## 7. Pitfalls e Rastreabilidade

> _[Placeholder]_ Versão mais curta. Remove: 7.2 (config file concurrency),
> 7.3 (proxy restart), 7.4 (Fernet encryption password), 7.7 (proxy não
> instalado), 7.8 (subprocess cleanup). Mantém: 7.1 (duplicação de contas),
> 7.5 (token lifecycle), 7.6 (Azure AD app registration), 7.9 (personal vs
> organizational).
>
> **Acrescenta:**
>
> - **Token cache corruption:** se a desserialização do `oauth_token_cache`
>   falhar (schema mudou, AES key rodou, bytes corrompidos), tratar como
>   "cache vazio" em vez de crashar — força re-auth graceful
> - **`acquireTokenSilent` falha:** refresh token expirado (90d de
>   inactividade MS) → exception específica → sync marca
>   `last_sync_status=error` com code `AUTH` → banner no dashboard com link
>   directo para wizard re-auth

---

## 8. Segurança

> _[Placeholder]_ Simplificado. Tokens encriptados em MongoDB com o
> AES-256-GCM já usado para `imap_password` (reutilizar
> `server/src/utils/crypto.js`). Client secret em env vars, nunca
> enviado ao frontend. Audit trail no CurveLog. Rate limiting nos
> endpoints OAuth.

---

## 9. Variáveis de Ambiente

> _[Placeholder]_ Apenas 3 vars, todas já existentes no contexto OAuth:
>
> | Variável | Descrição |
> |----------|-----------|
> | `AZURE_CLIENT_ID` | Client ID do Azure AD app registration |
> | `AZURE_CLIENT_SECRET` | Client secret (só necessário para confidential flows — DAG não precisa) |
> | `AZURE_TENANT_ID` | `common` (default) para multi-tenant + contas pessoais |
>
> **Removidas:** `EMAIL_PROXY_CONFIG_PATH`, `EMAIL_PROXY_VENV_PATH`,
> `EMAIL_PROXY_SERVICE_NAME`.

---

## 10. Migração da Implementação Actual

> _[Placeholder]_ Passos:
>
> 1. `CurveConfig` ganha campos OAuth (aditivos, nullable)
> 2. `imapReader.js` ganha branch `if (config.oauth_provider)` para usar
>    accessToken (mudança de ~5 linhas)
> 3. Novo serviço `server/src/services/oauthManager.js` encapsula MSAL +
>    cache plugin
> 4. Novos endpoints `/api/curve/oauth/*` e route handler
> 5. Frontend: novo wizard em `/curve/setup`, simplificação de
>    `/curve/config`
> 6. Backwards-compat: users com `imap_password` continuam a funcionar
>    (Caminho A). O branch OAuth só activa se `oauth_provider` estiver set.

---

## 11. Design Tips por Passo

> _[Placeholder]_ Mantém integralmente os design tips do V1 (paleta
> curve/sand, animações fade-in, layout do wizard, copy dos passos 0–4).
>
> **Dois ajustes minor:**
>
> - **Passo 3 checklist:** remove `✓ Proxy configurado` e
>   `✓ Serviço reiniciado`. Fica apenas `⏳ A testar ligação IMAP...` →
>   `✓ X pastas encontradas`.
> - **Passo 4 resumo:** remove a linha `Proxy  127.0.0.1:1993 activo`.
>   Substitui por `Autorização  válida até YYYY-MM-DD` (com base no
>   refresh token, que expira ~90 dias após última utilização).

---

## 12. Decisões em Aberto

> _[Placeholder]_
>
> - [ ] MSAL cache strategy: um `PublicClientApplication` por user
>       (construído on-demand) ou singleton com multi-account? On-demand é
>       mais simples mas re-cria o objecto a cada sync. Singleton partilha
>       cache em memória mas precisa de gestão manual por `homeAccountId`.
> - [ ] Scopes: `https://outlook.office.com/IMAP.AccessAsUser.All` +
>       `offline_access` chega? Testar em conta pessoal vs tenant.
> - [ ] DAG para Gmail: confirmar que não é suportado e forçar external-auth
>       para `@gmail.com` / `@googlemail.com`
> - [ ] Re-auth flow: quando `acquireTokenSilent` falha, o wizard deve
>       arrancar automaticamente ou mostrar banner "Clica aqui para
>       re-autorizar"?
> - [ ] AES key rotation: plano para rodar a master key sem perder tokens
>       (provavelmente: re-encriptar todos os caches no primeiro access
>       após rotação)
> - [ ] Gmail OAuth app registration: precisa de Google Cloud billing?
>       OAuth consent screen review?

---

## Apêndice A — Implementação legacy (V1, proxy-based)

A versão anterior deste documento descrevia o Caminho B do Curve Sync:
`email-oauth2-proxy` (Python) a correr como systemd unit, `emailproxy.config`
INI com tokens Fernet, e o backend Node a escrever directamente no ficheiro.

Esse documento está preservado em
**[`EMAIL_AUTH_V1_PROXY.md`](./EMAIL_AUTH_V1_PROXY.md)** para:

- Referência histórica das decisões tomadas
- Debug de instalações existentes (o ficheiro
  `docs/email-oauth2-proxy.service` ainda vive no repo e continua a ser o
  path de instalação suportado até a migração V2 estar completa)
- Comparação das trade-offs entre as duas abordagens

A secção correspondente em `docs/EMAIL.md` ("Installing email-oauth2-proxy
on the Raspberry Pi — Caminho B") continua válida para instalações V1.
