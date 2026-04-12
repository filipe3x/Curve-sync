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
