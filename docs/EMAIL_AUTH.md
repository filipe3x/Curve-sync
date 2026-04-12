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

Esta secção descreve as três peças que substituem o
`email-oauth2-proxy`:

1. **`imapflow`** (já instalado) — fala XOAUTH2 nativamente quando recebe
   um access token em vez de password
2. **`@azure/msal-node`** (nova dependência) — gere o consent flow
   (device code ou authorization code) e faz refresh silencioso dos
   access tokens
3. **Cache plugin** (código novo, ~80 linhas) — intermedia o MSAL e o
   MongoDB, reutilizando o `server/src/services/crypto.js` existente para
   encriptar o cache em repouso

A integração entre as três é pequena: um helper `getOAuthToken(config)`
que reconstrói um `PublicClientApplication` a partir de um CurveConfig,
chama `acquireTokenSilent`, e devolve uma string. O `imapReader.js` passa
essa string no `auth.accessToken` e o resto do pipeline continua inalterado.

### 3.1 imapflow suporta XOAUTH2 out of the box

O `ImapFlow` constructor aceita dois formatos de `auth`:

```javascript
// Basic auth (modo actual — App Password / plain)
new ImapFlow({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: { user: 'foo@gmail.com', pass: 'abcd efgh ijkl mnop' },
});

// XOAUTH2 (modo V2 — access token do MSAL)
new ImapFlow({
  host: 'outlook.office365.com',
  port: 993,
  secure: true,
  auth: { user: 'foo@outlook.com', accessToken: 'eyJ0eXAiOiJKV1QiLC...' },
});
```

Internamente o imapflow detecta a presença de `accessToken` e emite o
comando SASL `AUTHENTICATE XOAUTH2` com a string
`"user=foo@outlook.com\x01auth=Bearer eyJ0...\x01\x01"` em base64.
É o mesmo formato que o `email-oauth2-proxy` constrói — a diferença é que
passa a acontecer no próprio processo Node, sem traduzir plain LOGIN
intermédio.

**Implicações directas:**

- `imap_server` passa a ser `outlook.office365.com` (ou `imap.gmail.com`)
  em vez de `127.0.0.1`
- `imap_port` passa a ser `993` em vez de `1993`
- `imap_tls` passa a ser `true` em vez de `false`
- `imap_password` deixa de ser usado quando `oauth_provider` está set
- O check de loopback em `imapReader.js`
  (`isLoopbackHost` / `LOOPBACK_HOSTS`) deixa de ter sentido no branch
  OAuth — mantém-se para o branch App Password mas o branch OAuth força
  TLS sempre

### 3.2 @azure/msal-node — os três métodos que usamos

O `@azure/msal-node` expõe um `PublicClientApplication` (sem client secret)
e um `ConfidentialClientApplication` (com client secret). Para o nosso
caso o `PublicClientApplication` chega: DAG e authorization code grant
funcionam ambos com apps "public client".

Os três métodos relevantes:

| Método | Quando | Output |
|--------|--------|--------|
| `acquireTokenByDeviceCode` | Fluxo DAG no wizard (primeira autorização) | `AuthenticationResult` com `accessToken` + `account` + escreve no cache |
| `acquireTokenByCode` | Fluxo external-auth no wizard (primeira autorização) | idem |
| `acquireTokenSilent` | Cada sync — reutiliza ou faz refresh do cache | idem (transparent) |

O ciclo de vida é:

```
┌─────────────────┐
│  Wizard step 2  │   1ª vez: acquireTokenByDeviceCode ou acquireTokenByCode
│  (user consent) │   ─────────▶ tokens guardados no cache plugin ─────▶ MongoDB
└─────────────────┘
        │
        ▼
┌─────────────────┐
│  Sync (N×/hora) │   acquireTokenSilent
│                 │   ├─ access token ainda válido → devolve o que está em cache
│                 │   └─ access token expirado → usa refresh token → novo access
│                 │      ├─ sucesso → actualiza cache → MongoDB
│                 │      └─ refresh também expirou → InteractionRequiredAuthError
└─────────────────┘                                      │
                                                         ▼
                                            Dashboard banner: "Re-autoriza"
```

O refresh é **transparente**: o `acquireTokenSilent` trata de validar a
expiração do access token, pedir um novo ao endpoint `/token`, e persistir
no cache — tudo dentro da mesma chamada. O caller (getOAuthToken) não
precisa de saber se foi cache-hit ou refresh.

**Config mínima do `PublicClientApplication`:**

```javascript
import { PublicClientApplication, LogLevel } from '@azure/msal-node';

const app = new PublicClientApplication({
  auth: {
    clientId: process.env.AZURE_CLIENT_ID,
    authority: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID || 'common'}`,
  },
  cache: {
    cachePlugin,  // instância do cache plugin MongoDB (§3.4)
  },
  system: {
    loggerOptions: {
      loggerCallback: (level, message) => {
        if (level <= LogLevel.Warning) console.log(`[msal] ${message}`);
      },
      logLevel: LogLevel.Warning,
    },
  },
});
```

**Scopes:**

```javascript
const OUTLOOK_SCOPES = [
  'https://outlook.office.com/IMAP.AccessAsUser.All',
  'offline_access',   // pede refresh token — crítico, sem isto cada access dura 1h e acabou
];

const GMAIL_SCOPES = [
  'https://mail.google.com/',
  // Gmail devolve refresh token automaticamente na 1ª autorização
  // desde que access_type=offline e prompt=consent
];
```

### 3.3 Novos campos no CurveConfig

O schema actual (`server/src/models/CurveConfig.js`) ganha cinco campos,
todos nullable por default para não afectar users que continuam com
App Password:

```javascript
const curveConfigSchema = new mongoose.Schema({
  // ... campos existentes ...

  // OAuth provider name. null = this user uses App Password (V1 / Gmail
  // legacy). When set, imapReader.js takes the OAuth branch and uses
  // getOAuthToken() instead of imap_password.
  oauth_provider: {
    type: String,
    enum: ['microsoft', 'google', null],
    default: null,
  },

  // Serialized MSAL token cache, encrypted with AES-256-GCM via
  // server/src/services/crypto.js. MSAL serializes its cache as a JSON
  // blob (~2-4 KB) containing accessTokens, refreshTokens, idTokens and
  // account records. The cache plugin encrypts this blob before storing
  // and decrypts on read. Never exposed to the frontend.
  oauth_token_cache: {
    type: String,
    default: null,
  },

  // MSAL `homeAccountId` for this user's account within the cache. MSAL
  // supports multiple accounts per cache — we only ever have one per
  // CurveConfig, but we still need to remember which homeAccountId it is
  // so acquireTokenSilent can look it up. Format: `<uid>.<utid>`.
  oauth_account_id: {
    type: String,
    default: null,
  },

  // Azure AD client ID used for THIS specific account. Normally matches
  // process.env.AZURE_CLIENT_ID, but stored per-config so that a future
  // key rotation doesn't invalidate all existing caches — you can keep
  // old configs running on the old client_id until re-auth.
  oauth_client_id: {
    type: String,
    default: null,
  },

  // Azure AD tenant (`common`, `consumers`, `organizations`, or a GUID).
  // Defaults to `common` for multi-tenant + personal accounts. Stored
  // per-config because a single Curve Sync instance may serve users
  // from different tenants.
  oauth_tenant_id: {
    type: String,
    default: 'common',
  },
});
```

**Porque 5 campos e não 1 blob:**

- `oauth_token_cache` é opaco (serializado pelo MSAL); precisamos de
  metadata do nosso lado para saber "este user já fez consent?" sem
  desserializar
- `oauth_account_id` é o único identificador estável para
  `acquireTokenSilent({ account })` — não dá para inferir do cache
  sem o abrir
- `oauth_client_id` / `oauth_tenant_id` permitem migração gradual
  (registration nova vs antiga) sem tocar em configs que ainda funcionam

**Backwards compat:**

- User sem `oauth_provider` → branch App Password (comportamento actual)
- User com `oauth_provider = 'microsoft'` + `oauth_token_cache` != null →
  branch OAuth
- User com `oauth_provider` set mas `oauth_token_cache` null → wizard
  incompleto, tratar como "não configurado" e mandar para `/curve/setup`

### 3.4 MSAL cache plugin para MongoDB

O `@azure/msal-node` define a interface `ICachePlugin` com dois métodos:

```typescript
interface ICachePlugin {
  beforeCacheAccess(context: TokenCacheContext): Promise<void>;
  afterCacheAccess(context: TokenCacheContext): Promise<void>;
}
```

O contrato é simples:

- **`beforeCacheAccess`** — MSAL chama antes de cada operação de cache
  (read ou write). O plugin tem de chamar `context.tokenCache.deserialize(json)`
  com o JSON mais recente do storage
- **`afterCacheAccess`** — MSAL chama depois. Se
  `context.cacheHasChanged` for true, o plugin tem de chamar
  `context.tokenCache.serialize()` e persistir o resultado

Implementação (`server/src/services/oauthCachePlugin.js`):

```javascript
import CurveConfig from '../models/CurveConfig.js';
import { encrypt, decrypt } from './crypto.js';

/**
 * MSAL cache plugin bound to a specific user_id. Each sync creates a
 * fresh instance scoped to the CurveConfig being used — we do NOT share
 * a singleton plugin across users, because the plugin holds a user_id
 * closure and any shared state would risk cross-user token leakage.
 *
 * The plugin is cheap to create (one closure), so the cost of
 * per-request instantiation is negligible.
 */
export function createCachePlugin(userId) {
  return {
    async beforeCacheAccess(context) {
      const config = await CurveConfig.findOne({ user_id: userId }).lean();
      if (!config?.oauth_token_cache) {
        // No cache yet (first auth) — leave MSAL's empty in-memory cache
        // alone. MSAL treats an empty cache as "no accounts".
        return;
      }
      try {
        const plaintext = decrypt(config.oauth_token_cache);
        context.tokenCache.deserialize(plaintext);
      } catch (err) {
        // Corrupted or un-decryptable cache. Log once, treat as empty
        // cache, and let acquireTokenSilent fail naturally — the
        // orchestrator will surface a "re-authorize" banner. See §7
        // (Pitfalls — Token cache corruption).
        console.warn(
          `[oauth] token cache unreadable for user ${userId}: ${err.message}. ` +
          `Treating as empty — user will need to re-auth.`,
        );
      }
    },

    async afterCacheAccess(context) {
      if (!context.cacheHasChanged) return;
      const serialized = context.tokenCache.serialize();
      const ciphertext = encrypt(serialized);
      await CurveConfig.updateOne(
        { user_id: userId },
        { $set: { oauth_token_cache: ciphertext } },
      );
    },
  };
}
```

**Porque não partilhar o plugin entre users:**

Cada `PublicClientApplication` tem um único cache in-memory que é
populado por `beforeCacheAccess`. Se partilhássemos o plugin (e portanto
o mesmo PCA) entre users, o cache acabaria com os tokens de vários users
misturados — o `acquireTokenSilent` funcionaria por azar (graças ao
`homeAccountId`) mas o `afterCacheAccess` escreveria tudo no storage do
primeiro user que tivesse chamado. Isolamento por user é a única forma
segura.

**Alternativa considerada (rejeitada):** singleton PCA com um plugin que
usa uma Map keyed by `homeAccountId`. Mais eficiente mas muito mais
fácil de introduzir bugs de cross-user leakage. Vamos com per-request
instantiation — é barato o suficiente (um object literal + closure)
para não valer a pena optimizar.

### 3.5 Helper `getOAuthToken(config)`

O ponto de integração entre o `imapReader.js` e o MSAL:

```javascript
// server/src/services/oauthManager.js
import { PublicClientApplication, InteractionRequiredAuthError } from '@azure/msal-node';
import { createCachePlugin } from './oauthCachePlugin.js';

const SCOPES_BY_PROVIDER = {
  microsoft: [
    'https://outlook.office.com/IMAP.AccessAsUser.All',
    'offline_access',
  ],
  google: ['https://mail.google.com/'],
};

/**
 * Build a PublicClientApplication bound to a specific CurveConfig.
 * Called on every sync — cheap because MSAL's init is stateless and
 * the cache is populated lazily via the plugin.
 */
function buildMsalApp(config) {
  return new PublicClientApplication({
    auth: {
      clientId: config.oauth_client_id || process.env.AZURE_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${config.oauth_tenant_id || 'common'}`,
    },
    cache: { cachePlugin: createCachePlugin(config.user_id) },
  });
}

/**
 * Get a fresh access token for the account associated with `config`.
 *
 * On the happy path this is a cache hit and returns instantly. If the
 * cached access token is expired, MSAL silently exchanges the refresh
 * token for a new one and writes the updated cache back via the plugin.
 *
 * Throws OAuthReAuthRequired when the refresh token itself is expired
 * (90 days of inactivity for Microsoft). The sync orchestrator maps
 * this to `last_sync_status=error` with code `AUTH` and the dashboard
 * shows the re-auth banner. See §7.
 */
export async function getOAuthToken(config) {
  if (!config.oauth_provider) {
    throw new Error('getOAuthToken called on a config without oauth_provider');
  }
  if (!config.oauth_account_id) {
    throw new OAuthReAuthRequired('no account in cache — wizard not completed');
  }

  const app = buildMsalApp(config);
  const account = await app.getTokenCache().getAccountByHomeId(config.oauth_account_id);
  if (!account) {
    throw new OAuthReAuthRequired('account not found in cache (cache corrupted or wiped)');
  }

  try {
    const result = await app.acquireTokenSilent({
      account,
      scopes: SCOPES_BY_PROVIDER[config.oauth_provider],
    });
    return result.accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) {
      throw new OAuthReAuthRequired(err.errorCode || err.message);
    }
    throw err;
  }
}

export class OAuthReAuthRequired extends Error {
  constructor(message) {
    super(`OAuth re-authorization required: ${message}`);
    this.name = 'OAuthReAuthRequired';
    this.code = 'OAUTH_REAUTH';
  }
}
```

**Integração no `imapReader.js`:**

```javascript
// server/src/services/imapReader.js — constructor excerpt (V2)
import { getOAuthToken } from './oauthManager.js';

async function buildAuthConfig(config) {
  if (config.oauth_provider) {
    return {
      user: config.imap_username,
      accessToken: await getOAuthToken(config),
    };
  }
  return {
    user: config.imap_username,
    pass: config.imap_password,
  };
}

// The constructor becomes async-aware via a factory:
export async function createImapReader(config) {
  const auth = await buildAuthConfig(config);
  return new ImapReader(config, auth);
}
```

Nota: o `ImapReader` actual é um constructor síncrono. O branch OAuth
exige uma chamada assíncrona (o `acquireTokenSilent` pode ir à rede fazer
refresh), portanto a migração adiciona um factory assíncrono
`createImapReader(config)` e o orchestrator passa a usar a factory em
vez de `new ImapReader(config)`. A assinatura do constructor fica
`ImapReader(config, prebuiltAuth)` para manter testes síncronos com
fixtures.

### 3.6 Fluxo em runtime — primeiro sync após wizard

Sequência completa desde o user clicar "Activar Curve Sync" no passo 4
até o primeiro expense aparecer:

```
1. Wizard concluído
   └─▶ CurveConfig tem:
         oauth_provider = 'microsoft'
         oauth_account_id = '00000000-xxxx-xxxx-xxxx-xxxxxxxxxxxx.xxxx-...'
         oauth_token_cache = <AES-256-GCM(JSON blob com access+refresh)>
         imap_server = 'outlook.office365.com'
         imap_port = 993
         imap_tls = true
         imap_password = null

2. Scheduler dispara sync (cron, 5 min)
   └─▶ syncOrchestrator.js chama createImapReader(config)
       └─▶ buildAuthConfig(config) → oauth branch
           └─▶ getOAuthToken(config)
               ├─▶ buildMsalApp(config) → novo PCA com cachePlugin(user_id)
               ├─▶ app.getTokenCache().getAccountByHomeId(oauth_account_id)
               │   └─▶ beforeCacheAccess → MongoDB → decrypt → deserialize
               ├─▶ app.acquireTokenSilent({ account, scopes })
               │   ├─ cache hit (access token ainda válido)
               │   │  └─▶ devolve access token
               │   └─ cache miss (access token expirado)
               │      ├─▶ POST /token com refresh_token
               │      ├─▶ recebe novo access token
               │      ├─▶ afterCacheAccess → serialize → encrypt → MongoDB updateOne
               │      └─▶ devolve access token
               └─▶ return accessToken

3. ImapReader constrói cliente com auth: { user, accessToken }
   └─▶ imapflow envia AUTHENTICATE XOAUTH2 para outlook.office365.com:993
       └─▶ autenticação OK → SELECT folder → SEARCH UNSEEN SINCE ...
           └─▶ fetch loop → markSeenBatch → close
```

**Custos típicos:**

- Cache hit (90%+ dos syncs): ~50 ms para `getOAuthToken` (MongoDB read +
  deserialize + lookup)
- Cache miss / refresh (~1×/hora): ~300-500 ms extra (roundtrip ao token
  endpoint MS)
- Primeiro sync após wizard: cache miss garantido se demorou > 1h entre
  consent e primeiro sync, cache hit caso contrário

### 3.7 Erros e mapeamento

| Erro MSAL | Quando | Mapeamento Curve Sync |
|-----------|--------|----------------------|
| `InteractionRequiredAuthError` (code `invalid_grant`) | Refresh token expirado (90d inactividade) | `OAuthReAuthRequired` → `last_sync_status='error'`, code `AUTH`, banner no dashboard |
| `InteractionRequiredAuthError` (code `consent_required`) | Admin revogou consent do tenant | idem |
| `ClientAuthError` (code `no_tokens_found`) | Cache corrupto ou vazio | `OAuthReAuthRequired('no account in cache')` |
| `ServerError` (code `temporarily_unavailable`) | Azure AD down temporariamente | Deixar o sync falhar normalmente; retry no próximo schedule — não marcar como re-auth |
| Network timeout ao `/token` endpoint | Rede intermitente | idem |

O `OAuthReAuthRequired` é uma classe de erro nossa que o orchestrator
detecta e traduz em `last_sync_status='error'` + `last_error_code='AUTH'`
+ log dedicado. O frontend pinta um banner vermelho no dashboard com
botão "Re-autorizar" que manda o user directo para o passo 2 do wizard
(salta o passo 1 porque o email já é conhecido).

---

## 4. Fluxos OAuth Suportados

Dois fluxos, lado a lado — DAG para Microsoft, external-auth (authorization
code + PKCE + loopback) para Gmail e fallback universal. O diagrama abaixo
mostra quem fala com quem em cada um, onde entra o MSAL, e onde os tokens
aterram.

```
╔══════════════════════════════════════════════════════════════════════════╗
║  FLUXO A — DEVICE AUTHORIZATION GRANT (DAG)    — Microsoft primário     ║
╚══════════════════════════════════════════════════════════════════════════╝

  Frontend            Backend Express         @azure/msal-node      Microsoft
  (wizard)            /api/curve/oauth/*      (in-process)          login.*
     │                       │                      │                   │
     │  POST /start          │                      │                   │
     │  {email}              │                      │                   │
     ├──────────────────────▶│                      │                   │
     │                       │ app.acquireToken     │                   │
     │                       │   ByDeviceCode({     │                   │
     │                       │     deviceCode       │                   │
     │                       │     Callback, ... }) │                   │
     │                       ├─────────────────────▶│                   │
     │                       │                      │  POST /devicecode │
     │                       │                      ├──────────────────▶│
     │                       │                      │   {userCode,      │
     │                       │                      │    deviceCode,    │
     │                       │                      │    verifUri, ...} │
     │                       │                      │◀──────────────────┤
     │                       │  deviceCodeCallback  │                   │
     │                       │◀─────────────────────┤                   │
     │                       │  (MSAL começa poll   │                   │
     │                       │   interno cada 5s)   │                   │
     │  {flowId, userCode,   │                      │                   │
     │   verificationUri,    │                      │                   │
     │   expiresIn}          │                      │                   │
     │◀──────────────────────┤                      │                   │
     │                       │                      │                   │
     │  ┌─────────────────────────────────────────────────────────────┐ │
     │  │ Wizard mostra userCode em destaque + link verificationUri   │ │
     │  │                                                             │ │
     │  │ User (noutro dispositivo ou mesma máquina):                 │ │
     │  │   1. abre microsoft.com/devicelogin                         │ │
     │  │   2. insere userCode                                        │ │
     │  │   3. faz login                                              │ │
     │  │   4. consente                                               │ │
     │  └─────────────────────────────────────────────────────────────┘ │
     │                       │                      │                   │
     │  GET /poll?flowId=X   │                      │  poll /token      │
     │  (cada 5s)            │                      ├──────────────────▶│
     ├──────────────────────▶│                      │ authorization_    │
     │  {pending, ...}       │                      │   pending         │
     │◀──────────────────────┤                      │◀──────────────────┤
     │                       │                      │                   │
     │                       │                      │  (user consentiu) │
     │                       │                      ├──────────────────▶│
     │                       │                      │ {access_token,    │
     │                       │                      │  refresh_token,   │
     │                       │                      │  account, ...}    │
     │                       │                      │◀──────────────────┤
     │                       │                      │                   │
     │                       │ ┌── afterCacheAccess ──▶┐                │
     │                       │ │  encrypt + updateOne  │─▶ MongoDB       │
     │                       │ │  curve_configs        │   oauth_token_  │
     │                       │ └───────────────────────┘    cache        │
     │                       │                      │                   │
     │                       │  AuthResult          │                   │
     │                       │  {account:           │                   │
     │                       │    homeAccountId}    │                   │
     │                       │◀─────────────────────┤                   │
     │                       │ authFlows.set(flowId,│                   │
     │                       │   status=authorized) │                   │
     │  GET /poll?flowId=X   │                      │                   │
     ├──────────────────────▶│                      │                   │
     │  {authorized,         │                      │                   │
     │   accountId}          │                      │                   │
     │◀──────────────────────┤                      │                   │
     │                       │                      │                   │
     │  avança para passo 3  │                      │                   │



╔══════════════════════════════════════════════════════════════════════════╗
║  FLUXO B — AUTHORIZATION CODE + PKCE + LOOPBACK   — Gmail / fallback    ║
╚══════════════════════════════════════════════════════════════════════════╝

  Frontend            Backend Express         @azure/msal-node      Provider
  (wizard)            /api/curve/oauth/*      (in-process)          (Google/MS)
     │                       │                      │                   │
     │  POST /start          │                      │                   │
     │  {email}              │                      │                   │
     ├──────────────────────▶│                      │                   │
     │                       │ cryptoProvider       │                   │
     │                       │  .generatePkceCodes()│                   │
     │                       ├─────────────────────▶│                   │
     │                       │ {verifier, challenge}│                   │
     │                       │◀─────────────────────┤                   │
     │                       │                      │                   │
     │                       │ app.getAuthCodeUrl({ │                   │
     │                       │   scopes,            │                   │
     │                       │   redirectUri:       │                   │
     │                       │     'http://localhost│                   │
     │                       │   codeChallenge,     │                   │
     │                       │   codeChallengeMethod│                   │
     │                       │     = 'S256',        │                   │
     │                       │   loginHint: email })│                   │
     │                       ├─────────────────────▶│                   │
     │                       │ authorizeUrl         │                   │
     │                       │◀─────────────────────┤                   │
     │                       │                      │                   │
     │                       │ authFlows.set(flowId,│                   │
     │                       │   {verifier,         │                   │
     │                       │    status=pending,   │                   │
     │                       │    expiresAt})       │                   │
     │  {flowId,             │                      │                   │
     │   authorizeUrl}       │                      │                   │
     │◀──────────────────────┤                      │                   │
     │                       │                      │                   │
     │  ┌─────────────────────────────────────────────────────────────┐ │
     │  │ Wizard abre authorizeUrl em nova tab.                       │ │
     │  │                                                             │ │
     │  │ Browser do user:                                            │ │
     │  │   1. login no provider                                      │ │
     │  │   2. consent screen                                         │ │
     │  │   3. provider redirect →                                    │ │
     │  │      http://localhost?code=XYZ&state=...                    │ │
     │  │   4. browser: "localhost refused to connect" (normal)       │ │
     │  │   5. user copia URL da address bar                          │ │
     │  │   6. cola no textarea do wizard                             │ │
     │  └─────────────────────────────────────────────────────────────┘ │
     │                       │                      │                   │
     │  POST /complete       │                      │                   │
     │  {flowId,             │                      │                   │
     │   redirectUrl}        │                      │                   │
     ├──────────────────────▶│                      │                   │
     │                       │ extract `code` do URL│                   │
     │                       │ lookup authFlows →   │                   │
     │                       │   verifier           │                   │
     │                       │                      │                   │
     │                       │ app.acquireTokenBy   │                   │
     │                       │   Code({             │                   │
     │                       │     code,            │                   │
     │                       │     codeVerifier,    │                   │
     │                       │     redirectUri,     │                   │
     │                       │     scopes })        │                   │
     │                       ├─────────────────────▶│  POST /token      │
     │                       │                      ├──────────────────▶│
     │                       │                      │ {access_token,    │
     │                       │                      │  refresh_token,   │
     │                       │                      │  account, ...}    │
     │                       │                      │◀──────────────────┤
     │                       │                      │                   │
     │                       │ ┌── afterCacheAccess ──▶┐                │
     │                       │ │  encrypt + updateOne  │─▶ MongoDB       │
     │                       │ │  curve_configs        │   oauth_token_  │
     │                       │ └───────────────────────┘    cache        │
     │                       │                      │                   │
     │                       │  AuthResult          │                   │
     │                       │◀─────────────────────┤                   │
     │  {authorized,         │                      │                   │
     │   accountId}          │                      │                   │
     │◀──────────────────────┤                      │                   │
     │                       │                      │                   │
     │  avança para passo 3  │                      │                   │
```

**Pontos-chave do diagrama:**

1. **MSAL é in-process** — nunca sai do Node, não há comunicação HTTP
   entre o backend Express e o MSAL. As chamadas `app.acquireToken*` são
   imports directos.

2. **Tokens aterram em MongoDB automaticamente** — via
   `afterCacheAccess` do cache plugin (§3.4), dentro da mesma chamada
   `acquireTokenByDeviceCode` / `acquireTokenByCode`. O route handler
   não precisa de escrever os tokens manualmente.

3. **DAG: bridge callback → HTTP polling** — MSAL resolve uma única
   promise quando o user consente. Para devolver o `userCode` ao
   frontend imediatamente, o backend usa um deferred: espera pelo
   `deviceCodeCallback` (poucos ms), guarda a promise em `authFlows`
   para poll posterior, e devolve 202 com o `userCode`.

4. **External-auth: PKCE manual, verifier em memória** —
   `generatePkceCodes()` é async e **não é feito automaticamente** pelo
   `getAuthCodeUrl`. O verifier fica no `authFlows` (Map in-memory)
   entre `/start` e `/complete` — não pode ir para MongoDB
   (desnecessário) nem ser enviado ao frontend (quebra PKCE).

5. **Loopback redirect** — `http://localhost` é aceite por Azure AD e
   Google para "Desktop app" clients (RFC 8252). O browser tenta
   redirigir mas não há nada a escutar — é esperado, e o user copia o
   URL manualmente.

6. **`request.cancel = true`** — para abortar um DAG em curso (ex.: user
   cancela o wizard), basta mutar a flag no mesmo objecto request que
   passámos ao `acquireTokenByDeviceCode`. MSAL verifica entre polls.

**Estado in-memory (`authFlows`):**

| Campo | DAG | External-auth |
|-------|-----|---------------|
| `status` | pending / authorized / expired / declined / error | pending / authorized / expired / error |
| `userId` | ✓ | ✓ |
| `expiresAt` | ✓ (expires_in do MS) | ✓ (10 min) |
| `request` (mutable) | ✓ (para `cancel = true`) | — |
| `verifier` | — | ✓ (secret PKCE) |
| `accountId` | após resolve | após resolve |

TTL automático via `setTimeout`; não persiste entre restarts do server
(restart durante flow pending → user vê `flow_not_found` no poll, wizard
oferece retry).

**Detalhe da API (verificado contra o source do `@azure/msal-node`):**

- `DeviceCodeRequest.deviceCodeCallback` recebe `DeviceCodeResponse`
  com `userCode`, `deviceCode`, `verificationUri`, `expiresIn`,
  `interval`, `message`. É síncrono do ponto de vista do MSAL.
- `DeviceCodeRequest.cancel` é um **boolean mutável** no próprio objecto
  request, não um token de cancelamento. Além disso há `timeout`
  (segundos) para hard ceiling.
- `CryptoProvider.generatePkceCodes()` é **async** — precisa de
  `await`. PKCE **não** é automático no manual auth-code flow (é no
  `acquireTokenInteractive`, que é outro método).
- `TokenCacheContext` expõe `cacheHasChanged` (getter) e `hasChanged`
  (property directa) — ambos funcionam, §3.4 usa `cacheHasChanged`
  por consistência.

---

## 5. Wizard — Passos do Frontend

Topic outline. Expandir na fase de implementação com copy final, design
específico, e handlers por caso de erro. A parte visual/design per-step
vive na §11 (Design Tips por Passo), esta secção é sobre estrutura,
state machine e comportamento.

### 5.1 Estrutura geral

- **Rotas e entry points**
  - `/curve/setup` — wizard completo (users sem config)
  - `/curve/config` — settings simplificados (users já configurados:
    pasta, intervalo, toggle sync)
  - `/curve/setup?reauth=1&email=X` — re-auth entry point (salta steps
    0 + 1, começa no step 2 com email pré-preenchido)
  - Redirect rules: `/curve/config` redirige para `/curve/setup` se
    `oauth_provider` null ou `oauth_token_cache` null
- **State machine** (5 estados: 0 → 1 → 2 → 3 → 4 → done)
  - Transições: avançar / recuar / abortar
  - State ownership: wizard state no frontend (Zustand ou useReducer),
    backend é stateless excepto pelo `authFlows` Map do step 2
  - Não persistir em localStorage — mid-flow refresh implica recomeçar
    (aceitável, wizard é curto). Excepção: `flowId` em sessionStorage
    para sobreviver a F5 acidental no step 2.
- **Abort / cancelar**
  - Botão "Cancelar" presente em todos os steps
  - `DELETE /api/curve/oauth/abort?flowId=X`
  - DAG: mutação `request.cancel = true` no objecto guardado em
    `authFlows` → MSAL pára o polling e a promise rejeita
  - External-auth: `authFlows.delete(flowId)` (sem efeito upstream,
    só liberta memória + verifier)
- **Multi-tab concurrency**
  - `authFlows` é keyed por `flowId` (não por user), cada tab tem o
    seu → não há conflito
  - Última tab a completar ganha — o CurveConfig é overwritten. Aceitável.

### 5.2 Step 0 — Boas-vindas

**Objectivo UX:** transformar um processo que o user pode achar
intimidante numa narrativa simples. O user não conhece "OAuth" e não
precisa de conhecer. Deve sentir que está a configurar o Curve Sync
como configuraria o Thunderbird ou o Outlook no telemóvel.

**Copy sugerido:**

> **Configurar acesso ao email**
>
> Os serviços de email deixaram de aceitar passwords directas por
> questões de segurança. Para ler os teus recibos do Curve Pay, o Curve
> Sync precisa que autorizes o acesso — é o mesmo processo que fazes
> quando adicionas uma conta de email num telemóvel novo.
>
> Demora cerca de 2 minutos. Vais inserir o teu email, autorizar o
> acesso uma vez, e o Curve Sync trata do resto automaticamente.

**Banlist de vocabulário:** OAuth, IMAP, token, proxy, config, refresh
token, XOAUTH2, device code, authorization code, PKCE, cache.

**Replacelist:** "autorização" (não "OAuth"), "acesso ao email"
(não "IMAP"), "ligação" (não "connection"), "recibos" (não "emails").

**Layout:**

- Card centrado, `max-w-lg`, sem sidebar (full-focus)
- Ícone hero (64px) — envelope com escudo ou cadeado
- Copy em 3 parágrafos com `space-y-3`
- Um único botão primário full-width: "Começar"
- Sem "Cancelar" neste step (não há nada para cancelar ainda)
- Step indicator (5 dots) discreto no topo da card

### 5.3 Step 1 — Email + detecção de provider

**Objectivo UX:** recolher o email e dar feedback imediato de que o
Curve Sync reconhece o provider. O user deve sentir que o sistema
"sabe o que está a fazer".

**Copy sugerido:**

- Título: "Qual é o email que recebe os recibos?"
- Label: "Email"
- Placeholder: `o-teu-email@exemplo.com`
- Helper text (cinza, pequeno): "Este é o email que recebe os recibos
  do Curve Pay — não é necessariamente a tua conta Embers."
- Toggle override (aparece para domínios não-reconhecidos):
  "A minha empresa usa Microsoft 365"
- Botão primário: "Continuar"
- Botão secundário: "Cancelar" (volta a `/curve/config` se existir,
  ou a `/`)

**Comportamento do input (estados visuais):**

| Estado | Border | Trailing icon | Helper |
|--------|--------|---------------|--------|
| Default | `sand-300` | — | padrão |
| Focus | `curve-500` ring | — | padrão |
| Typing (debouncing) | `sand-300` | — | padrão |
| Checking backend | `sand-400` | spinner `curve-300` | "A verificar..." |
| Valid + novo | `emerald-400` | check `emerald-600` | badge de provider |
| Valid + já tem config | `amber-400` | warning `amber-600` | "Já tens esta conta. [Re-autorizar]" |
| Valid + conflito user | `red-400` | cross `red-600` | "Este email já está associado a outra conta" |
| Invalid format | `red-400` | cross `red-600` | "Email inválido" |

**Badge de provider** (aparece abaixo do input após validação):

- Microsoft: `bg-blue-50 text-blue-700` + ícone Outlook — "Conta Microsoft detectada"
- Google: `bg-red-50 text-red-700` + ícone Gmail — "Conta Google detectada"
- Unknown: `bg-sand-100 text-sand-600` + ícone `?` — "Provider não reconhecido — vamos tentar"

**Backend contract:** `GET /api/curve/oauth/check-email?email=X` →
`{ exists, conflict, provider_hint }`
- `exists=true conflict=false` (mesmo user) → estado amber, link directo
  para re-auth
- `exists=true conflict=true` (outro user) → estado red, avançar bloqueado
- `exists=false` → estado emerald, "Continuar" habilitado

**Auto-detecção por domínio (frontend-side, instantâneo):**
- `@outlook.*` / `@hotmail.*` / `@live.*` / `@msn.com` → microsoft
- `@gmail.com` / `@googlemail.com` → google
- outro → unknown (mostra toggle override)

**Pitfalls a mitigar:**
- Typo no email → só descoberto no step 2; ter confirmação visual aqui
  (badge) ajuda a apanhar cedo
- User copia com espaços → trim + lowercase antes de validar
- Tenant O365 com domínio próprio → toggle manual converte unknown → microsoft

### 5.4 Step 2 — Autorização OAuth

**Objectivo UX:** conseguir o consent sem o user se perder. É o step mais
complexo — duas variantes, múltiplos sub-estados, countdown — e o que
mais beneficia de micro-copy cuidada e feedback visual imediato.

Dois sub-variants auto-seleccionados pelo `provider_hint` do step 1.

---

#### 5.4.A — Variante DAG (Microsoft)

**Copy sugerido:**

> **Autoriza o acesso ao teu email**
>
> Clica no botão abaixo para abrir a página da Microsoft. Vais precisar
> de inserir este código:
>
> `[ A1B2 C3D4 ]`  ← destaque visual
>
> [Copiar código]  [Abrir microsoft.com/devicelogin →]
>
> **1.** Abre o link acima
> **2.** Insere o código quando pedido
> **3.** Faz login com a tua conta de email
> **4.** Autoriza o acesso (vai aparecer uma app chamada "Thunderbird"
> — é normal)
> **5.** Volta a esta página — detectamos automaticamente quando
> terminas
>
> ⏳ À espera da tua autorização… `12:34` restantes

**Explainer colapsável "Thunderbird" (banner amber discreto):**

> ℹ️ **Porque aparece "Thunderbird"?**
>
> O Curve Sync usa a mesma identificação que clientes de email como o
> Thunderbird para aceder aos teus recibos. É uma prática comum em
> ferramentas que leem email via OAuth, e não partilha nenhum dado com
> terceiros.

**Layout:**

- Código em card `bg-curve-50 rounded-xl px-6 py-4`, fonte mono
  `text-3xl font-bold text-curve-700 tracking-[0.3em]`, centrado
- Botão "Copiar código" abaixo do código, `btn-secondary` pequeno.
  Ao copiar: ícone transiciona para check + texto muda para "Copiado!"
  durante 2s
- Botão "Abrir microsoft.com/devicelogin" em destaque (`btn-primary`),
  com ícone de external link e `target="_blank" rel="noopener"`
- Lista numerada com `list-decimal`, passos curtos
- Countdown: texto `text-sand-600 → amber-600 → red-600` conforme
  expira. Formato `M:SS`.
- Polling status card no fundo: `bg-sand-50` a pulsar suavemente
  durante `pending`, transiciona para `bg-emerald-50` ao `authorized`

**Backend contract:**
- `POST /api/curve/oauth/start { email, provider: 'microsoft' }`
  → `{ flowId, userCode, verificationUri, expiresIn }`
- `GET /api/curve/oauth/poll?flowId=X` a cada 5s
  → `{ status: 'pending' | 'authorized' | 'expired' | 'declined' | 'error', expiresIn? }`
- `DELETE /api/curve/oauth/abort?flowId=X` (botão "Cancelar")

**Estados UX do polling:**

| Status | Visual | Acção |
|--------|--------|-------|
| `pending` | spinner `curve-300`, countdown | polling continua |
| `authorized` | card border `emerald-400`, check animado | avançar ao step 3 com fade |
| `expired` | card border `red-300`, cross | botão "Tentar de novo" → novo flowId |
| `declined` | card border `red-300` | "A autorização foi recusada" + retry |
| `error` | card border `red-300` | "Algo correu mal" + retry |

---

#### 5.4.B — Variante External-auth (Gmail / fallback)

**Copy sugerido:**

> **Autoriza o acesso ao teu email**
>
> O Google pede-te para autorizar num processo separado.
>
> [Abrir página de autorização Google →]
>
> **1.** Clica no botão para abrir a página do Google numa nova tab
> **2.** Faz login e autoriza o acesso
> **3.** O browser vai mostrar "localhost refused to connect" —
>    **é perfeitamente normal**
> **4.** Copia o endereço **completo** da barra do browser
> **5.** Cola aqui em baixo
>
> ┌────────────────────────────────────┐
> │ http://localhost?code=...          │ ← textarea para paste
> └────────────────────────────────────┘
>
> [Validar]  [Cancelar]

**Layout:**

- Botão "Abrir página de autorização" em destaque (`btn-primary`)
- Lista numerada com passo 3 realçado: `font-semibold text-amber-700`
  no "É perfeitamente normal" para evitar pânico
- Aviso persistente `bg-amber-50 border-amber-200`:
  > ⚠️ Copia o URL **antes** de fechar a página de erro — depois de
  > fechar, perdes o código e tens de recomeçar.
- Textarea: `font-mono text-xs`, 3 rows, resize-none, placeholder
  `http://localhost?code=...`
- Botão "Validar" disabled até o textarea conter `code=`
  (validação regex frontend antes de enviar ao backend)
- Mini-ilustração opcional: screenshot estilizado da address bar com
  highlight na zona do URL

**Backend contract:**
- `POST /api/curve/oauth/start { email, provider: 'google' }`
  → `{ flowId, authorizeUrl }`
- `POST /api/curve/oauth/complete { flowId, redirectUrl }`
  → `{ status: 'authorized', accountId } | { status: 'error', code }`

**Erros comuns e recuperação:**

| Erro | Mensagem | Recuperação |
|------|----------|-------------|
| Textarea vazio | "Cola o URL no campo acima" | focus no textarea |
| Sem `code=` no URL | "O URL não parece correcto — confirma que copiaste o endereço completo" | re-edit |
| URL contém `error=access_denied` | "A autorização foi recusada" | tentar de novo ou cancelar |
| Código já expirado | "O código expirou — abre a página de novo" | reset do flow |
| Network / 5xx | "Não conseguimos validar — tenta outra vez" | retry button |

---

**Transição step 2 → step 3:** ao receber `authorized`, fade-out da card
(200ms), fade-in do step 3 (300ms) com leve slide-up. Nunca teleportar.

### 5.5 Step 3 — Verificação e selecção de pasta

**Objectivo UX:** confirmar visualmente que tudo funciona e deixar o
user escolher onde vão ser lidos os recibos. Deve ser rápido — o user
acabou de autorizar, quer ver sucesso.

**Simplificado vs V1** — sem proxy a configurar, sem restart de serviço.

**Copy sugerido:**

> **A confirmar tudo…**
>
> ⏳ A testar ligação ao teu email…
> ✓ Ligação estabelecida
>
> ⏳ A procurar a pasta dos recibos…
> ✓ Encontrámos 17 pastas
>
> **Qual é a pasta que recebe os recibos do Curve Pay?**
>
> [Dropdown: Curve Receipts ✓]  ← pre-seleccionado
>
> 💡 Pasta recomendada detectada automaticamente.
>
> [Voltar]  [Continuar]

**Layout da checklist:**

- Vertical stack, cada item `flex items-center gap-3`
- Ícones `h-5 w-5`:
  - Pending: spinner SVG `text-curve-300 animate-spin`
  - Success: check SVG `text-emerald-600`, com animação de "draw-in"
    (stroke-dasharray)
  - Error: cross SVG `text-red-500`
- Texto: `text-sm text-sand-700` durante pending, `text-sand-900`
  quando completo
- Items aparecem sequencialmente com `animate-fade-in` (cada um com
  `delay` de 200ms após o anterior completar) — nunca tudo de uma vez

**Comportamento interno:**

1. Carrega CurveConfig (já populado pelo complete do step 2)
2. `getOAuthToken(config)` — valida que os tokens funcionam
   (`acquireTokenSilent`, cache hit imediato). **Se falhar, lança
   `OAuthReAuthRequired`** — o step recua para 2 com mensagem clara
3. `testConnection(config)` — open IMAP connection + list folders +
   close. Devolve array de folder paths.

**Dropdown de pasta (aparece após checklist completa):**

- `animate-fade-in-up` com delay 200ms após último check
- Border `border-emerald-200` (sucesso visual subtil)
- Pre-seleccionar "Curve Receipts" se existir (ou variantes:
  "INBOX/Curve Receipts", "Curve", etc — matching case-insensitive)
- Hint verde abaixo: "Pasta recomendada detectada"
- Fallback: INBOX seleccionada, hint amber:
  "Não encontrámos 'Curve Receipts'. Podes usar INBOX ou criar uma
  regra no teu email para mover os recibos para uma pasta específica."
- Auto-save da selecção (debounce 300ms, consistente com
  comportamento actual do CurveConfig)

**Estados de erro:**

| Erro | Mensagem | Recuperação |
|------|----------|-------------|
| `OAuthReAuthRequired` | "A autorização falhou — vamos tentar de novo" | auto-recuo ao step 2 após 3s |
| `CONNECT` (network) | "Não conseguimos ligar ao servidor de email" | retry button |
| `AUTH` (tokens rejeitados) | "O teu email rejeitou o acesso" | recuo ao step 2 |
| Folder list vazia | "O teu email não retornou nenhuma pasta" | contactar admin, detalhes colapsáveis |
| Timeout (>10s) | "A ligação está muito lenta" | retry |

Detalhes técnicos colapsáveis (`<details>`) em caso de erro, `font-mono
text-xs text-sand-500 bg-sand-50 rounded p-3` — úteis para debug sem
poluir o UX normal.

### 5.6 Step 4 — Activar sincronização

**Objectivo UX:** momento de conclusão. O user já fez o trabalho todo
— este step é essencialmente uma confirmação visual + ajustes finos +
celebração subtil quando termina.

**Copy sugerido:**

> **Tudo pronto!**
>
> ┌─────────────────────────────────────────┐
> │ EMAIL                                   │
> │ user@outlook.com                        │
> │                                         │
> │ PROVIDER                                │
> │ Microsoft  [ícone]                      │
> │                                         │
> │ PASTA                                   │
> │ Curve Receipts                          │
> │                                         │
> │ AUTORIZAÇÃO                             │
> │ Válida até 12 Julho 2026                │
> └─────────────────────────────────────────┘
>
> **De quanto em quanto tempo verificamos?**
> [5] minutos
>
> [×] Sincronizar automaticamente
>
> [  Activar Curve Sync  ]

**Layout do card resumo:**

- Grid 2 colunas (label + value) em `sm:`, stacked em mobile
- Labels: `text-xs text-sand-400 uppercase tracking-wide`
- Valores: `text-sm font-medium text-sand-900`
- Separator entre resumo e inputs: `border-t border-sand-100 my-4`
- Ícone do provider à esquerda do nome (16px)

**Inputs editáveis:**

- Intervalo sync: number input com steppers, `min=1 max=60`, default 5
- Toggle "Sincronização automática activa": switch component, default
  `on` — se `off`, o scheduler não arranca mas a config é guardada na
  mesma (user pode activar mais tarde em `/curve/config`)

**"Autorização válida até":**
- Apenas para Microsoft (refresh token tem TTL conhecido: 90 dias
  desde última utilização)
- Formato: "Válida até 12 Julho 2026" (Intl.DateTimeFormat `pt-PT`)
- Para Google: esconder a linha (Google não expõe TTL de refresh token
  e eles são efectivamente permanentes enquanto o user não revoga)
- Tooltip (`title`): "Vais receber um aviso antes de expirar para
  re-autorizares sem perder sincronizações."

**Botão final — estados:**

| Estado | Visual | Texto |
|--------|--------|-------|
| Default | `btn-primary w-full py-3 text-base font-semibold` | "Activar Curve Sync" |
| Loading | mesma classe, com spinner inline, disabled | "A activar…" |
| Success | border `emerald-400`, fade | "Activado" + checkmark animado |
| Error | border `red-300` | "Algo correu mal — tentar de novo" |

**Idempotência:**
- Botão vira `disabled` + "A activar…" no click (protecção anti
  double-click)
- Backend `PUT /api/curve/config` é idempotente (re-enviar os mesmos
  valores não tem efeito adverso)

**Success UX completo:**

1. Click "Activar" → botão vira spinner
2. Backend retorna OK → card transiciona border para `emerald-200`
   (duração 300ms)
3. Checkmark grande aparece centrado com `animate-fade-in-up`
4. Texto muda para "Curve Sync activo!" em
   `text-emerald-700 text-xl font-semibold`
5. Sub-texto: "A primeira sincronização vai correr dentro de 5 minutos.
   Vais ser redireccionado para o dashboard."
6. Progress bar subtil de 3s a contar para baixo
7. Auto-redirect para `/`
8. Dashboard mostra badge "Sync activo" na sidebar por 10s para
   continuidade visual

### 5.7 Re-auth flow (entry point especial)

- Trigger: sync falha com `OAuthReAuthRequired` → `last_sync_status=error`
  com code `AUTH` → banner vermelho no dashboard com link
- URL: `/curve/setup?reauth=1&email=X` (email vem do CurveConfig)
- Wizard:
  - Skip step 0 (sem boas-vindas — user já conhece o processo)
  - Skip step 1 (email já conhecido, validação implícita)
  - Começa directamente no step 2 com o provider_hint já resolvido
  - Após step 2 success, step 3 é fast-path (só confirma ligação, não
    mostra dropdown — folder já está set)
  - Step 4 pode ser skipado completamente, ou mostrado read-only
    com botão "Voltar ao dashboard"
- CurveLog: log especial `wizard_reauth_completed` para distinguir
  de setups iniciais

### 5.8 Error recovery matrix

Cada step tem uma tabela de erros esperados → mensagem user-facing →
acção de recuperação. **Golden rule:** nunca deixar o user num beco sem
saída; sempre oferecer "Tentar de novo" ou "Voltar".

Exemplos para expandir na implementação:

| Step | Erro | Mensagem | Recuperação |
|------|------|----------|-------------|
| 1 | Email em uso por outro user | "Este email já está associado a outra conta" | Cancelar, contactar admin |
| 2 | DAG expired | "O código expirou" | Tentar de novo (novo flowId) |
| 2 | Paste-back sem `code=` | "O URL não parece correcto" | Editar textarea |
| 2 | `access_denied` | "A autorização foi recusada" | Tentar de novo ou cancelar |
| 3 | `OAuthReAuthRequired` | "A autorização falhou" | Voltar ao step 2 |
| 3 | Network timeout | "Não conseguimos ligar ao servidor" | Retry |
| 4 | PUT /config 5xx | "Erro ao guardar a configuração" | Retry |

### 5.9 Layout & information architecture

- **Container do wizard** — `max-w-lg mx-auto` (mais estreito do que as
  outras páginas do Curve Sync; foco total, sem distracções laterais)
- **Sem sidebar / sem navegação** — o wizard é um modo à parte. A
  sidebar normal do Curve Sync é escondida durante `/curve/setup` para
  reforçar que o user está num fluxo linear
- **Card único por step** — não full-page, sem header próprio. Tudo
  vive dentro de um `bg-white rounded-2xl shadow-sm border border-sand-200 p-8`
  centrado verticalmente
- **Progress indicator no topo da card** — 5 dots `h-2 w-2 rounded-full`,
  `sand-300` inactivos, `curve-700` activo, com `transition-colors
  duration-300`. Não é click-to-navigate — é apenas indicador.
- **Zona de acção no fundo** — botões stacked verticalmente em mobile,
  side-by-side em `sm+`. "Voltar" como `btn-secondary` à esquerda,
  "Continuar" / acção primária como `btn-primary` à direita. Excepção
  step 0 (só "Começar") e step 4 (só "Activar").
- **Sem scroll dentro da card** — se o conteúdo não cabe, aumentar a
  altura da card ou partir o passo. Nunca ter scroll interno num
  wizard step (quebra o sentido de "uma tarefa, uma vista").

### 5.10 Voice, tone & copy guidelines

**Voice:**

- **Singular, informal** — "tu", "o teu email", "vamos fazer isto".
  Consistente com o tom de toda a UI do Curve Sync.
- **Confiante sem ser arrogante** — "o Curve Sync trata do resto" em
  vez de "é super fácil!". Evitar entusiasmo falso.
- **Transparente sobre privacidade** — quando relevante, explicar o
  que é lido e o que não é. Exemplo no step 0: "vamos ler apenas os
  recibos que o Curve Pay te envia".
- **Reconhece fricção em vez de a esconder** — passo 3 do external-auth
  diz "vai mostrar um erro — é normal!" em vez de fingir que não
  acontece.
- **Zero emoji** (confirmado no CLAUDE.md do projecto — não adicionar
  emoji ao UI a menos que explicitamente pedido). Usar SVG icons.

**Banlist de vocabulário** (nunca usar no UI user-facing):

- OAuth, OAuth 2.0, XOAUTH2, SASL, PKCE
- IMAP, SMTP, POP, TLS, SSL
- token, access token, refresh token, cache
- proxy, bridge, config, systemd
- device code, authorization code, device flow
- endpoint, callback, API, JSON
- registration, tenant, client ID, client secret

**Replacelist** (usar em vez disso):

| Em vez de | Dizer |
|-----------|-------|
| "configurar OAuth" | "autorizar o acesso" |
| "obter access token" | "autorizar o email" |
| "IMAP connection" | "ligação ao email" |
| "refresh token expirado" | "a autorização expirou" |
| "token inválido" | "o email rejeitou o acesso" |
| "proxy" | (não mencionar — é invisível) |
| "folder" / "mailbox" | "pasta" |
| "sync" (quando dirigido ao user) | "verificar recibos" ou "sincronizar" |

**Strings-chave do wizard:**

```
Título wizard      "Configurar acesso ao email"
Step 0 título      "Vamos ligar o Curve Sync ao teu email"
Step 1 título      "Qual é o email que recebe os recibos?"
Step 2 título      "Autoriza o acesso"
Step 3 título      "A confirmar tudo…"
Step 4 título      "Tudo pronto!"
Botão cancelar     "Cancelar"
Botão voltar       "Voltar"
Botão continuar    "Continuar"
Botão activar      "Activar Curve Sync"
Success toast      "Curve Sync activo!"
Error genérico     "Algo correu mal — tenta outra vez"
```

### 5.11 Transições entre steps

- **Animação padrão de entrada:** `animate-fade-in-up` (opacity
  0 → 1 + translateY 8px → 0) com `duration-400 ease-out`
- **Animação de saída:** fade-out rápido (`duration-200`) antes do
  novo step fazer fade-in — não cross-fade (evita flicker)
- **Transição avançar vs recuar:**
  - Avançar: novo step slide-in da direita (subtil, +12px → 0)
  - Recuar: novo step slide-in da esquerda (−12px → 0)
  - Simbolicamente alinha com a "direcção" do fluxo
- **Não mudar de página / rota** — todo o wizard vive em `/curve/setup`;
  as transições acontecem dentro do mesmo container. Histórico browser
  tratado via `replaceState` (sem entradas no back button para cada step)
- **Exceção: success do step 4** — a transição para `/` é uma navegação
  real, precedida de 3s de celebração no próprio card
- **Reduzido motion** — respeitar `prefers-reduced-motion` e cair em
  fades simples sem translate

### 5.12 Micro-interactions & feedback

- **Copy-to-clipboard (step 2 DAG):** botão "Copiar código" → ao
  click, ícone SVG transiciona para check verde + texto muda para
  "Copiado!" durante 2s, depois reverte. Haptics no mobile via
  `navigator.vibrate(10)` quando disponível.
- **Countdown do step 2:** cor muda conforme aproxima de 0:
  `sand-600` (>5 min) → `amber-600` (1–5 min) → `red-600` (<1 min).
  Pulsação subtil (scale 1 ↔ 1.02) no último minuto.
- **Input validation do step 1:** debounce 500ms antes de chamar
  backend. Durante a espera: spinner pequeno à direita do input
  (substitui temporariamente check/cross). Transições entre estados
  com `transition-colors duration-200`.
- **Checklist do step 3:** cada item faz "draw-in" do checkmark via
  `stroke-dasharray` animado (SVG) — sensação de "foi mesmo feito
  agora". Delay de 200ms entre items para cadência natural.
- **Botão "Activar" do step 4:** hover com `scale-[1.01]` subtil,
  active com `scale-[0.99]`. Loading state troca texto + adiciona
  spinner inline.
- **Success do step 4:** card faz pulso verde `bg-emerald-50 →
  bg-white` por 300ms, depois checkmark desenha-se, depois texto de
  sucesso aparece. Sequência encadeada, não tudo de uma vez.

### 5.13 Empty states & edge cases

- **Primeiro visit sem config:** ao aceder `/curve/config` pela
  primeira vez, redirect automático para `/curve/setup`. Sem página
  intermédia.
- **Mid-flow refresh:** state local perdido, user cai no step 0. Uma
  pequena nota (sand-600, `text-xs`) na primeira card: "Começámos do
  início — só demora 2 minutos." Sem acusação, sem fricção.
- **Network offline:** banner persistente no topo da card `bg-red-50
  text-red-700`: "Sem ligação à internet — religa para continuar".
  Todos os CTAs ficam `disabled` até `navigator.onLine` voltar.
- **Provider desconhecido (step 1):** copy neutral — "Vamos tentar o
  método padrão". Fallback silencioso para external-auth sem explicar
  porquê (o user não precisa de saber a taxonomia de flows).
- **Azure AD app não configurada (erro de deployment):** step 2
  falha com erro genérico + `<details>` técnico. Copy: "Algo não
  está configurado no lado do Curve Sync. Contacta o administrador."
  Não culpar o user.
- **Wizard abandonado a meio (telemetria):** sem garbage collection
  necessário — `authFlows` tem TTL automático, nada persiste em DB
  a não ser tokens após step 2 complete (e mesmo esses ficam inócuos
  sem `oauth_provider` set).

### 5.14 Accessibility

- **Focus management:** auto-focus no primeiro input/botão de cada
  step. Ao mudar de step, mover focus para o título (h2) com `tabindex=-1`
  para anunciar em screen readers.
- **Keyboard shortcuts:**
  - `Enter` = continuar (quando o form é válido)
  - `Esc` = cancelar (com confirmação no step 2+ para evitar perda
    acidental)
  - `Tab` / `Shift+Tab` navegam entre inputs e botões dentro da card
- **ARIA:**
  - `aria-live="polite"` nas mensagens de erro e no texto de status do
    polling (step 2)
  - `aria-busy="true"` nos spinners durante operações
  - `role="progressbar"` + `aria-valuenow` / `aria-valuemax` no
    countdown do step 2
  - `aria-describedby` ligando inputs aos helper texts
- **Contraste:** todos os textos cumprem WCAG AA (4.5:1) — a paleta
  `sand-*` já está calibrada para isto, mas verificar especificamente
  os helper texts em `sand-400` / `sand-500`
- **Screen reader hints:** o código DAG é lido carácter a carácter
  (`aria-label="código A, 1, B, 2, C, 3, D, 4"`) para facilitar
  transcrição

### 5.15 Telemetria

Events mínimos no CurveLog para perceber onde users desistem:

- `wizard_started` — quando o step 0 monta
- `wizard_step_reached` com `{ step: 0..4 }`
- `wizard_completed` — submit bem-sucedido do step 4
- `wizard_abandoned_at` com `{ step, reason }` — detectado via
  beforeunload ou timeout no lado do cliente. `reason` pode ser
  `refresh`, `close_tab`, `explicit_cancel`, `navigation_away`.
- `wizard_reauth_completed` — distinguível de setups iniciais
- `wizard_reauth_failed` com motivo

Não enviar PII nos eventos — `user_id` basta, o email vive no
CurveConfig. Agregar no dashboard com queries simples sobre o CurveLog.

---

## 6. Backend — Novos Endpoints

Listagem concentrada. Só endpoints OAuth + integração com os existentes.
**Todos os endpoints de proxy management desaparecem** (`/api/curve/proxy/*`
deixa de existir).

Todos os endpoints abaixo estão montados em `/api/curve/oauth/*`, exigem
autenticação (cookie de sessão Embers, como os outros endpoints do Curve
Sync), e são scoped ao `user_id` da sessão — nunca aceitam `user_id` no
body/query.

### 6.1 OAuth flow — novos

#### `GET /api/curve/oauth/check-email`

Verifica se um email já está associado a alguma `CurveConfig`. Usado no
step 1 do wizard para bloquear duplicados e oferecer re-auth inline.

```
Request:
  GET /api/curve/oauth/check-email?email=user@outlook.com

Response 200:
  {
    "exists": false,
    "provider_hint": "microsoft"   // microsoft | google | unknown
  }

Response 200 (same user, already configured):
  {
    "exists": true,
    "conflict": false,
    "provider_hint": "microsoft"
  }

Response 200 (different user owns this email):
  {
    "exists": true,
    "conflict": true,
    "provider_hint": "microsoft"
  }
```

**Implementação:** lookup por `CurveConfig.imap_username`, cross-check
com `user_id` da sessão, derivar `provider_hint` do sufixo do domínio.

---

#### `POST /api/curve/oauth/start`

Inicia um fluxo OAuth (DAG ou authorization code). O comportamento muda
conforme `provider` / `flow` — a response é polimórfica.

```
Request:
  {
    "email": "user@outlook.com",
    "provider": "microsoft"        // microsoft | google
  }
```

**Response para Microsoft (DAG):**

```
Response 200:
  {
    "flow": "device_code",
    "flowId": "f5a7c2e1-...",
    "userCode": "A1B2C3D4",
    "verificationUri": "https://microsoft.com/devicelogin",
    "expiresIn": 900,
    "message": "To sign in, use a web browser..."
  }
```

**Response para Google (external-auth):**

```
Response 200:
  {
    "flow": "authorization_code",
    "flowId": "f5a7c2e1-...",
    "authorizeUrl": "https://accounts.google.com/o/oauth2/auth?...",
    "expiresIn": 600
  }
```

**Response 429 / 400:**

```
  { "error": "too_many_active_flows" }     // max 3 flows pendentes por user
  { "error": "invalid_provider" }
  { "error": "email_in_use_by_other_user" }
```

**Implementação:**
- Instancia `PublicClientApplication` via `buildMsalApp(config)` (ver §3)
- DAG: chama `acquireTokenByDeviceCode` com `deviceCodeCallback` que
  resolve um deferred; guarda a promise top-level em `authFlows` para
  polling posterior (ver §4.1 e o snippet completo de
  `startDeviceCodeFlow`)
- External-auth: gera PKCE via `cryptoProvider.generatePkceCodes()`,
  chama `getAuthCodeUrl`, guarda `verifier` em `authFlows`
- `flowId = crypto.randomUUID()`, TTL automático via `setTimeout`

---

#### `GET /api/curve/oauth/poll`

Polling para flows DAG. Frontend chama a cada 5 segundos durante o
step 2. Para external-auth **não é usado** — o sucesso chega via
`/complete`.

```
Request:
  GET /api/curve/oauth/poll?flowId=f5a7c2e1-...

Response 200 (pending):
  {
    "status": "pending",
    "expiresIn": 845
  }

Response 200 (authorized):
  {
    "status": "authorized",
    "accountId": "00000000-0000-0000-0000-000000000000.xxxxxxxx-..."
  }

Response 200 (terminal error):
  { "status": "expired" }
  { "status": "declined" }
  { "status": "error", "error": "AADSTS..." }

Response 404:
  { "error": "flow_not_found" }             // flowId TTL'd ou inválido
```

**Side effect ao primeiro `authorized`:** actualiza o `CurveConfig` do
user com:
- `oauth_provider`
- `oauth_account_id`
- `oauth_client_id`
- `oauth_tenant_id`
- `imap_server`, `imap_port`, `imap_tls`, `imap_username`
  (hardcoded para o provider)
- `imap_password` set para `null`

Os tokens em si **já foram persistidos** pelo cache plugin durante a
resolução do `acquireTokenByDeviceCode` — este endpoint só escreve a
metadata para o `CurveConfig` saber que conta usar no
`acquireTokenSilent` futuro.

---

#### `POST /api/curve/oauth/complete`

Finaliza um fluxo external-auth (Gmail e providers sem DAG). Recebe o
URL de redirect colado pelo user e executa o token exchange.

```
Request:
  {
    "flowId": "f5a7c2e1-...",
    "redirectUrl": "http://localhost?code=4/0AX4X...&state=..."
  }

Response 200:
  {
    "status": "authorized",
    "accountId": "103...@gmail.com"
  }

Response 400:
  { "error": "no_code_in_url" }
  { "error": "access_denied" }
  { "error": "invalid_grant" }             // código expirado / usado
  { "error": "flow_expired" }              // passaram > 10 min desde /start

Response 404:
  { "error": "flow_not_found" }
```

**Implementação:**
1. Lookup do `flowId` em `authFlows`
2. Parse do `redirectUrl` (URL nativo), extrair `code` e `error`
3. Se `error` → devolver terminal error
4. Chamar `app.acquireTokenByCode({ code, codeVerifier, redirectUri, scopes })`
5. Tokens persistem automaticamente via cache plugin
6. Actualizar `CurveConfig` com a mesma metadata do `/poll` authorized
7. Remover entry do `authFlows`

---

#### `DELETE /api/curve/oauth/abort`

Cancela um flow em curso (botão "Cancelar" no step 2 do wizard).
Idempotente — chamar com um `flowId` inexistente não é erro.

```
Request:
  DELETE /api/curve/oauth/abort?flowId=f5a7c2e1-...

Response 200:
  { "cancelled": true }
```

**Implementação:**
- DAG: lookup, mutar `request.cancel = true` no request armazenado,
  depois `authFlows.delete`. MSAL vai detectar a flag no próximo poll
  interno e rejeitar a promise com `DEVICE_CODE_CANCEL`.
- External-auth: `authFlows.delete` (nada mais a cancelar —
  `getAuthCodeUrl` é uma chamada síncrona que já terminou)

---

#### `GET /api/curve/oauth/status`

Estado dos tokens do user actual. Usado pelo dashboard para decidir se
mostra banner de "Re-autorizar necessário" e pelo wizard para detectar
se o user já completou o setup.

```
Request:
  GET /api/curve/oauth/status

Response 200 (user sem OAuth configurado — usa App Password ou nada):
  {
    "configured": false,
    "provider": null
  }

Response 200 (OAuth configurado e funcional):
  {
    "configured": true,
    "provider": "microsoft",
    "email": "user@outlook.com",
    "tokenState": "valid",                 // valid | refreshed | reauth_required
    "lastCheckedAt": "2026-04-12T14:32:00Z",
    "estimatedExpiresAt": "2026-07-11T14:32:00Z"
  }

Response 200 (token expirado — precisa de re-auth):
  {
    "configured": true,
    "provider": "microsoft",
    "email": "user@outlook.com",
    "tokenState": "reauth_required",
    "lastCheckedAt": "2026-04-12T14:32:00Z",
    "error": "refresh_token_expired"
  }
```

**Implementação:** chama `getOAuthToken(config)` em modo "probe" — se
devolve token → `valid`; se lança `OAuthReAuthRequired` → `reauth_required`.
Resultado cacheado por 60s em memória para evitar chamadas a MSAL em
cada render do dashboard.

---

#### `DELETE /api/curve/oauth`

Desliga OAuth do user: revoga tokens (best-effort, chama o endpoint de
revocação do provider), limpa o cache, e reseta os campos OAuth do
`CurveConfig` para null. Usado por um "Desligar conta" explícito nas
definições.

```
Request:
  DELETE /api/curve/oauth

Response 200:
  { "disconnected": true }
```

**Implementação:**
1. Lookup do CurveConfig do user
2. Best-effort revocation: POST ao `/revoke` do provider com o refresh
   token (se for Google) ou skip (MS não tem revoke público para
   public clients)
3. `CurveConfig.updateOne({ user_id }, { $unset: { oauth_token_cache,
   oauth_account_id, oauth_client_id, oauth_tenant_id }, $set: {
   oauth_provider: null, sync_enabled: false } })`
4. Log no CurveLog (`oauth_disconnected`)

**Nota:** desligar OAuth não apaga expenses nem logs históricos — só
para a sync e desassocia a conta.

---

### 6.2 Endpoints existentes — integração com o wizard

Estes endpoints já existem e **não mudam**. O wizard apenas os chama
na sequência certa.

| Endpoint | Step | Uso no wizard |
|----------|------|---------------|
| `GET /api/curve/config` | bootstrap | Detectar se user já tem config → decidir rota (`/setup` vs `/config`) |
| `PUT /api/curve/config` | 5.6 (step 4) | Guardar `imap_folder`, `sync_interval_minutes`, `sync_enabled`, `imap_folder_confirmed_at`. **Não** escreve `oauth_*` fields (esses vêm do `/poll` ou `/complete`) |
| `POST /api/curve/test-connection` | 5.5 (step 3) | Validar ligação IMAP + listar pastas. **Importante:** internamente passa a usar o branch `accessToken` via `createImapReader(config)` quando `oauth_provider` está set |
| `POST /api/curve/sync` | — | Não usado directamente pelo wizard. Pode ser chamado pós-step 4 para correr a primeira sync imediatamente em vez de esperar pelo scheduler |
| `GET /api/curve/logs` | — | Não usado pelo wizard |

**Nota sobre `test-connection`:** é o único endpoint existente que
precisa de um pequeno refactor — actualmente instancia `ImapReader`
directamente (síncrono). Passa a chamar `createImapReader(config)`
(async factory do §3.5) para que o branch OAuth resolva o access
token antes de abrir a ligação.

### 6.3 Rate limiting

| Endpoint | Limite | Motivo |
|----------|--------|--------|
| `POST /oauth/start` | 5 / hora / user | Prevenir enumeration e abuso do Azure AD / Google |
| `POST /oauth/complete` | 10 / hora / user | Proteger contra paste-back brute force |
| `GET /oauth/poll` | sem limite | Polling legítimo (5s) |
| `GET /oauth/check-email` | 30 / hora / user | Prevenir enumeration de emails configurados |
| `GET /oauth/status` | sem limite (já cacheado) | Dashboard refresh |
| `DELETE /oauth` | 3 / hora / user | Operação destrutiva |
| `DELETE /oauth/abort` | sem limite | Cancelamento é user-driven e infrequente |

Implementação: middleware `express-rate-limit` com memory store (Pi é
single-instance, não precisa de Redis). Chaves compostas por
`user_id + endpoint`.

### 6.4 Audit trail

Todos os endpoints OAuth registam no `CurveLog`:

| Evento | Endpoint | Campos extra |
|--------|----------|--------------|
| `oauth_flow_started` | `/start` | `flowId`, `provider`, `flow_type` |
| `oauth_flow_completed` | `/poll`, `/complete` | `flowId`, `provider`, `accountId` |
| `oauth_flow_cancelled` | `/abort` | `flowId` |
| `oauth_flow_expired` | (TTL cleanup) | `flowId`, `last_status` |
| `oauth_flow_failed` | `/poll`, `/complete` | `flowId`, `error_code` |
| `oauth_token_refreshed` | sync background | `provider` |
| `oauth_reauth_required` | sync background | `provider`, `error_code` |
| `oauth_disconnected` | `DELETE /oauth` | `provider` |

Nunca logar valores de tokens, code verifiers, ou URLs de redirect
completas (podem conter `code=`). Logar apenas metadata.

---

---

## 7. Pitfalls e Rastreabilidade

Sub-tópicos a cobrir:

- **7.1 Duplicação de contas** — mesmo email autorizado duas vezes gera
  `homeAccountId` diferente; política de overwrite vs. conflito
- **7.2 Token lifecycle** — access token 1h, refresh token ~90d de
  inactividade MS, como detectar e expor ao user
- **7.3 Azure AD app registration** — redirect URIs permitidos (`http://localhost`),
  public client flag, scopes delegados, platform "Mobile and desktop"
- **7.4 Personal vs. organizational accounts** — tenant `common` vs. tenant
  específico, comportamento quando o tenant admin bloqueou IMAP
- **7.5 Token cache corruption** — desserialização falha (schema mudou, AES
  key rodou, bytes corrompidos) → tratar como cache vazio → re-auth graceful
- **7.6 `acquireTokenSilent` falha** — refresh token expirado → exception
  `InteractionRequiredAuthError` → sync marca `last_sync_status=error` code
  `AUTH` → banner com link directo para wizard re-auth
- **7.7 Clock skew** — Pi com hora errada faz MSAL rejeitar tokens
  (`nbf`/`exp` fora de janela); checar NTP antes de diagnosticar AUTH
- **7.8 Rastreabilidade** — correlação entre CurveLog `oauth_flow_*`, Azure
  sign-in logs e mailbox audit logs quando algo corre mal em produção

---

## 8. Segurança

Sub-tópicos a cobrir:

- **8.1 Encryption at rest** — tokens em `oauth_token_cache` encriptados
  com AES-256-GCM (reutilizar `server/src/services/crypto.js`); mesma key
  que já encripta `imap_password` (env `IMAP_ENCRYPTION_KEY`)
- **8.2 Isolamento por user** — cache plugin é factory, não singleton;
  `beforeCacheAccess` lê sempre o doc do user do request
- **8.3 Secrets em env vars** — `AZURE_CLIENT_ID` / `CLIENT_SECRET` /
  `TENANT_ID` nunca enviados ao frontend; checklist de `.env.example`
- **8.4 PKCE verifier** — vive só no `authFlows` in-memory, nunca persistido
  nem enviado ao browser; TTL de 10min
- **8.5 Audit trail** — todos os eventos OAuth em CurveLog (ver §6.4) com
  retenção TTL 90d
- **8.6 Rate limiting** — tabela §6.3 + justificação (anti-abuse do flow
  start/poll/complete)
- **8.7 Revogação** — `DELETE /api/curve/oauth` limpa cache local; docs de
  como o user revoga no lado do provider (account.microsoft.com,
  myaccount.google.com)
- **8.8 Threat model (curto)** — que acontece se atacante ganha acesso ao
  MongoDB? Ao `.env`? À sessão web? Nenhuma destas dá acesso completo
  sozinha — precisa de duas

---

## 9. Variáveis de Ambiente

Sub-tópicos a cobrir:

- **9.1 Azure AD (Microsoft)** — `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`
  (opcional — só para confidential flows; DAG/PKCE não precisam),
  `AZURE_TENANT_ID` (default `common`)
- **9.2 Google OAuth (Gmail)** — `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`;
  condicional (só se Gmail for suportado na V2 — decisão em §12)
- **9.3 Encryption** — `IMAP_ENCRYPTION_KEY` (já existe; reutilizado para
  cache de tokens)
- **9.4 Removidas vs. V1** — `EMAIL_PROXY_CONFIG_PATH`, `EMAIL_PROXY_VENV_PATH`,
  `EMAIL_PROXY_SERVICE_NAME` desaparecem
- **9.5 `.env.example`** — actualizar com as novas vars + comentários
  explicando quais são mandatory vs. optional
- **9.6 Validação no boot** — server falha fast se `AZURE_CLIENT_ID` estiver
  em falta e qualquer user tiver `oauth_provider='microsoft'`

---

## 10. Migração da Implementação Actual

Sub-tópicos a cobrir:

- **10.1 Schema additions** — campos OAuth em `CurveConfig` (todos
  aditivos/nullable, sem migration destrutiva); ordem dos PRs
- **10.2 `imapReader.js` refactor** — factory `createImapReader(config)`
  async; branch `if (config.oauth_provider)` resolve token antes de
  construir `ImapFlow`; call-sites a actualizar
- **10.3 Novo serviço `oauthManager.js`** — encapsula MSAL
  (`buildMsalApp`, `createCachePlugin`, `getOAuthToken`,
  `OAuthReAuthRequired`)
- **10.4 Novos endpoints** — route handler `/api/curve/oauth/*` (§6.1)
  e integração com os existentes (§6.2)
- **10.5 Frontend** — novo wizard em `/curve/setup`; simplificação de
  `/curve/config` (retira campos server/port/tls/username/password do
  path OAuth, mantém-nos para o path App Password legado)
- **10.6 Dependências npm** — `@azure/msal-node`; remoção futura de
  qualquer código/docs que invoquem `email-oauth2-proxy`
- **10.7 Backwards compatibility** — users com `imap_password` continuam
  a funcionar (Caminho A / App Password); branch OAuth só activa se
  `oauth_provider != null`
- **10.8 Roll-out & rollback** — feature-flag `ENABLE_OAUTH_WIZARD`;
  plano de rollback se algo correr mal em produção (desactivar flag,
  users OAuth ficam sem sync, users App Password inalterados)
- **10.9 Deprecation path do V1** — quando remover
  `docs/email-oauth2-proxy.service`, `EMAIL_AUTH_V1_PROXY.md`, secção
  Caminho B do `EMAIL.md`

---

## 11. Design Tips por Passo

Sub-tópicos a cobrir (complemento prático ao §5):

- **11.1 Paleta e tokens** — curve/sand do Tailwind config, semantic
  colours emerald/amber/red, quando cada uma entra
- **11.2 Animações** — fade-in por step, crossfade entre variantes
  DAG/external-auth, skeleton loading para poll
- **11.3 Passo 0 — Boas-vindas** — hero copy, ilustração minimal, CTA
  primário vs. link secundário "já usei antes"
- **11.4 Passo 1 — Email** — validação live, hint de provider detectado,
  fallback para conta corporativa
- **11.5 Passo 2 — Autorização (DAG)** — code box grande, countdown, botão
  "Abrir Microsoft" com copy-to-clipboard fallback
- **11.6 Passo 2 — Autorização (external-auth)** — link único, textarea
  paste-back, validação do URL
- **11.7 Passo 3 — Verificação** — checklist animada; remove items de
  proxy do V1 (`✓ Proxy configurado`, `✓ Serviço reiniciado`); fica
  `⏳ A testar ligação IMAP...` → `✓ X pastas encontradas`
- **11.8 Passo 4 — Activar sync** — resumo com `Autorização válida até
  YYYY-MM-DD` (substitui `Proxy 127.0.0.1:1993 activo` do V1); toggle
  sync + CTA final
- **11.9 Re-auth banner** — estado visual no dashboard quando
  `OAuthReAuthRequired` dispara; um clique para wizard
- **11.10 Responsive & mobile** — wizard funciona em mobile (paste-back
  especialmente)

---

## 12. Decisões em Aberto

Sub-tópicos a decidir antes de merge:

- [ ] **12.1 MSAL cache strategy** — `PublicClientApplication` por user
  (on-demand) vs. singleton multi-account por `homeAccountId`
- [ ] **12.2 Scopes Microsoft** — confirmar que
  `https://outlook.office.com/IMAP.AccessAsUser.All` + `offline_access`
  chega em conta pessoal vs. tenant
- [ ] **12.3 Suporte Gmail na V2** — in-scope ou deferir? Google Cloud
  billing, OAuth consent screen review, DAG não suportado →
  external-auth obrigatório
- [ ] **12.4 Re-auth UX** — banner passivo vs. redirect automático para
  wizard quando `OAuthReAuthRequired` dispara
- [ ] **12.5 AES key rotation** — plano para rodar `IMAP_ENCRYPTION_KEY`
  sem perder token caches (re-encrypt on first access pós-rotação?)
- [ ] **12.6 Feature flag** — `ENABLE_OAUTH_WIZARD` como gate ou
  soft-launch? (relacionado com 10.8)
- [ ] **12.7 Testes** — estratégia para testar MSAL sem bater no Azure
  real (mock do `PublicClientApplication`? test tenant?)
- [ ] **12.8 Monitorização** — métricas úteis pós-launch
  (taxa de re-auth, AUTH errors/day, flow completion rate por provider)

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
