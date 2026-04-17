# EMAIL_AUTH_MVP.md — Scope e sequenciamento do MVP V2

> Plano operacional para arrancar a migração descrita em
> [`EMAIL_AUTH.md`](./EMAIL_AUTH.md) (V2, direct XOAUTH2, sem proxy).
> Este documento **não** repete o desenho — assume que o leitor tem o V2
> em cima da mesa e só define **o que entra no primeiro corte**, **por
> que ordem**, e **o que fica para depois**.
>
> Referência canónica continua a ser `EMAIL_AUTH.md`. Quando houver
> conflito, ganha o V2. Este ficheiro só define fronteiras e prioridades.

---

## 1. Objectivo do MVP

Ter um Curve Sync multi-user onde:

1. Um novo utilizador completa o onboarding inteiro no browser, sem
   SSH, sem ficheiros INI, sem proxy a correr em 127.0.0.1.
2. O backend fala XOAUTH2 directamente com `outlook.office365.com:993`
   via `imapflow` + `@azure/msal-node`.
3. O refresh token é gerido automaticamente, e a falha silenciosa do V1
   (refresh expirado → zero emails sem erro) passa a ser um erro visível
   com banner de re-autorização.
4. Users que ainda usam App Password (V1 / Gmail legacy) continuam a
   funcionar sem mudanças — a migração é aditiva.

O MVP está "feito" quando um segundo utilizador consegue ligar a sua
conta Outlook pessoal ao Curve Sync partindo de zero, sem tocar no
servidor e sem a minha ajuda.

---

## 2. Dentro vs. fora do MVP

### 2.1 Dentro

| Área | O que entra | Referência V2 |
|------|-------------|---------------|
| Providers | **Só Microsoft** (contas pessoais + O365) via DAG | §4 fluxo A |
| Schema | 5 novos campos em `CurveConfig`, todos nullable | §3.3 |
| MSAL | `buildMsalApp`, `getOAuthToken`, `OAuthReAuthRequired` | §3.5 |
| Cache | `oauthCachePlugin.js` factory-por-user com AES-256-GCM | §3.4 |
| IMAP | Factory async `createImapReader(config)` | §3.5 / §10.2 |
| Rotas | `check-email`, `start`, `poll`, `status` | §6.1 |
| Wizard | 5 passos funcionais (0→4), só variante DAG no passo 2 | §5.2–§5.6 |
| Re-auth | Banner no dashboard quando `OAuthReAuthRequired` dispara | §3.7 / §5.7 |
| Audit | `oauth_flow_started/completed/failed/reauth_required` no CurveLog | §6.4 (subset) |
| Back-compat | Branch App Password intocado quando `oauth_provider=null` | §3.6 |

### 2.2 Fora (fase 2+)

| Adiado | Porquê | Referência V2 |
|--------|--------|---------------|
| Gmail / external-auth | Google Cloud billing + OAuth consent review + paste-back frágil | §4 fluxo B, §5.4.B |
| `DELETE /oauth` (disconnect) | Nice-to-have; user pode limpar manualmente no 1º corte | §6.1 |
| `DELETE /oauth/abort` | User pode fechar a tab; `authFlows` TTL limpa sozinho | §6.1 |
| Rate limiting fino | Meter um genérico e refinar | §6.3 |
| Telemetria wizard | Agrega-se depois de termos users reais | §5.15 |
| Animações / micro-interactions | Polish depois de estar estável | §5.11, §5.12 |
| A11y completo (screen readers, ARIA custom) | WCAG básica sim, o resto fase 2 | §5.14 |
| Feature flag `ENABLE_OAUTH_WIZARD` | Pool de users pequeno e conhecido, não vale o custo | §10.8 |
| Re-auth entry point dedicado (`?reauth=1`) | No MVP o banner leva ao wizard normal, user refaz desde o step 1 | §5.7 |
| Key rotation AES | Problema real só quando houver >1 chave | §12.5 |
| Testes contra Azure real vs. mock | No MVP, smoke manual + unit com fake MSAL | §12.7 |

Nada do que está "fora" é impossível de acrescentar depois sem refactor
— o desenho do V2 já o acomoda. O MVP é corte de âmbito, não atalho
arquitectural.

---

## 3. Pré-requisitos bloqueantes

Três coisas precisam de estar resolvidas **antes** de escrever código de
produção no passo 3 em diante. Qualquer uma destas bloqueia o MVP se
descoberta tarde.

### 3.1 Azure AD App Registration

Criar uma app no portal Azure AD (ou via `az ad app create`) com:

- **Supported account types:** `Accounts in any organizational directory
  and personal Microsoft accounts` (tenant `common`)
- **Platform:** `Mobile and desktop applications`
- **Redirect URIs:** `http://localhost` (para permitir o fluxo external-auth
  no futuro; DAG não usa mas não custa deixar)
- **Allow public client flows:** **ON** (crítico para DAG sem secret)
- **API permissions (delegated):**
  - `https://outlook.office.com/IMAP.AccessAsUser.All`
  - `offline_access` (sem isto, não há refresh token → cada sync expira em 1h)

Output: `AZURE_CLIENT_ID` (guardar no `.env` do servidor). `CLIENT_SECRET`
não é necessário para public client + DAG.

**Validação manual (antes do passo 3):** criar uma conta burner
`@outlook.com`, correr o DAG uma vez via script standalone, confirmar
que `acquireTokenSilent` devolve um access token que abre IMAP. Se
isto falhar, nada do resto importa.

### 3.2 Decisão locked: cache plugin é factory-por-user

O V2 discute a alternativa singleton em §3.4 e rejeita-a. **No MVP não
reabrir essa discussão** — implementar directamente como factory, sem
optimização prematura.

### 3.3 Decisão locked: imap_username = email autorizado

No MVP, `imap_username` é sempre igual ao email que o user passou no
step 1 do wizard (e que o MSAL devolve no `account.username` após o
DAG). Sem UI para configurar username separado. Se no futuro houver
tenants O365 onde UPN ≠ email, trata-se aí.

---

## 4. Sequência de implementação (PRs)

Cada PR é independente, mergeable, e deixa `main` funcional. O branch
de desenvolvimento é `claude/multi-user-imap-service-OavZW`.

### PR 1 — Schema + env (preparação)

**Scope:**
- Adicionar os 5 campos OAuth a `server/src/models/CurveConfig.js` com
  `default: null` (§3.3 do V2)
- Actualizar `server/.env.example` com `AZURE_CLIENT_ID` e
  `AZURE_TENANT_ID=common`
- Adicionar `@azure/msal-node` a `server/package.json` (não usado ainda,
  só para bloquear a versão)

**Testes:** nenhum — mudança puramente declarativa. Existing users
lidos via `CurveConfig.findOne` devolvem os novos campos como `null`,
o que não quebra nada.

**Risco:** zero. Não há consumidores dos novos campos ainda.

### PR 2 — `oauthCachePlugin.js`

**Scope:**
- Novo ficheiro `server/src/services/oauthCachePlugin.js` com
  `createCachePlugin(userId)` conforme §3.4
- Reutiliza `encrypt`/`decrypt` existentes em `crypto.js`
- Tratamento de cache corrupto: warn + treat-as-empty (§7.5)

**Testes:** unit test com um fake `TokenCacheContext` que:
1. Arranca sem cache → `beforeCacheAccess` é no-op
2. `afterCacheAccess` com `cacheHasChanged=true` escreve no MongoDB
3. `beforeCacheAccess` subsequente lê e deserializa
4. Cache adulterado à mão → warn + treat as empty, sem throw

**Risco:** baixo. Isolado, sem call-sites.

### PR 3 — `oauthManager.js`

**Scope:**
- Novo ficheiro `server/src/services/oauthManager.js`
- Exports: `buildMsalApp(config)`, `getOAuthToken(config)`,
  `OAuthReAuthRequired` (§3.5)
- Só suporta `oauth_provider='microsoft'` no MVP — `google` lança erro
  explícito "not implemented in MVP"

**Testes:** unit test com `PublicClientApplication` mockado:
1. Config sem `oauth_account_id` → lança `OAuthReAuthRequired`
2. `acquireTokenSilent` ok → devolve string
3. `InteractionRequiredAuthError` → lança `OAuthReAuthRequired`
4. Outros erros → re-lança sem wrapping

**Risco:** baixo. Sem call-sites ainda.

### PR 4 — `imapReader.js` factory async

**Scope:**
- Novo export `createImapReader(config)` async (§3.5)
- Construtor actual passa a aceitar `(config, prebuiltAuth)` para
  preservar fixtures síncronos
- Actualizar call-sites:
  - `server/src/services/syncOrchestrator.js`
  - `server/src/routes/curve.js` (`test-connection`, sync manual)
- Branch `oauth_provider ? accessToken : pass` no `buildAuthConfig`

**Testes:**
- Unit: `createImapReader` com config App Password → mesmo
  comportamento que antes
- Unit: `createImapReader` com `oauth_provider='microsoft'` →
  chama `getOAuthToken` (mockado) e passa accessToken
- Smoke manual: popular `oauth_*` à mão via MongoDB shell com tokens
  reais de um DAG corrido via script standalone, disparar sync manual,
  confirmar que expenses entram

**Risco:** médio. Todos os call-sites actuais mudam de `new
ImapReader(config)` para `await createImapReader(config)`. Exige
atenção a funções que antes eram síncronas e agora precisam de `async`.

**Ponto de retorno:** no fim do PR 4, um user já pode ser configurado
manualmente em OAuth (inserindo `oauth_*` no MongoDB) e o sync
funciona end-to-end. Os PRs seguintes são só UX para automatizar essa
configuração.

### PR 5 — Rotas `/api/curve/oauth/*` (DAG only)

**Scope:**
- Novo ficheiro `server/src/routes/curveOauth.js` montado em
  `/api/curve/oauth`
- Endpoints:
  - `GET /check-email` — §6.1
  - `POST /start` — só `provider='microsoft'`, retorna DAG response
  - `GET /poll` — polling por `flowId`, side effect de escrever
    `oauth_*` no `CurveConfig` ao primeiro `authorized`
  - `GET /status` — com cache in-memory 60s
- Map in-memory `authFlows` com TTL via `setTimeout`
- Logging no `CurveLog`: `oauth_flow_started`, `oauth_flow_completed`,
  `oauth_flow_failed`, `oauth_reauth_required`
- Rate limiting mínimo: `express-rate-limit` 5/hora em `/start`, default
  nos outros

**Endpoints fora do MVP:** `complete`, `abort`, `DELETE /oauth`. O wizard
não precisa destes para o fluxo DAG funcionar.

**Testes:**
- Integration: `POST /start` → `GET /poll` (pending) → simular
  conclusão do DAG → `GET /poll` (authorized) → verificar `CurveConfig`
  actualizado
- Integration: `GET /check-email` com email já em uso / novo / conflito

**Risco:** médio. Novo código com lifecycle complexo (promises deferred,
TTL, state in-memory). Restart do server durante flow pending → user
vê `flow_not_found` (aceitável, wizard oferece retry).

### PR 6 — Wizard frontend

**Scope:**
- Nova página `client/src/pages/CurveSetupPage.jsx` em `/curve/setup`
- 5 steps com state machine (useReducer):
  - Step 0 — boas-vindas (§5.2)
  - Step 1 — email + detecção provider (§5.3), só Microsoft no MVP
  - Step 2 — DAG (§5.4.A), sem polish de countdown avançado
  - Step 3 — verificação IMAP + folder picker (§5.5)
  - Step 4 — activar sync (§5.6)
- API calls em `client/src/services/api.js`
- `/curve/config` redirect para `/curve/setup` quando
  `oauth_provider=null` **E** `has_imap_password=false`
- Banner de re-auth no dashboard quando `/oauth/status` devolve
  `tokenState='reauth_required'`
- Copy em PT conforme V2 §5.10 (banlist de vocabulário)

**Fora:** animações (fade-in-up, crossfade, pulse), micro-interactions
(copy-to-clipboard animado, countdown colorido), ARIA custom, telemetria,
persistência de flowId em sessionStorage, multi-tab handling.

**Testes:** smoke manual completo com conta burner; sem testes automáticos
de frontend no MVP.

**Risco:** baixo do ponto de vista de backend — só consome APIs. O
trabalho é mecânico.

### PR 7 — Smoke test e segundo user

**Scope:**
- Correr o wizard completo com uma conta burner Outlook pessoal
- Esperar >1h, confirmar que o próximo sync faz refresh silencioso
  (observar `oauth_token_refreshed` no CurveLog)
- Forçar re-auth manual (apagar o cache na DB), confirmar que o sync
  falha com `OAuthReAuthRequired` e o banner aparece
- Onboarding do segundo user a partir de outra conta

**Sem mudanças de código** excepto bug fixes encontrados durante o smoke.

---

## 5. Dependências novas

| Package | Versão alvo | Onde | Porquê |
|---------|-------------|------|--------|
| `@azure/msal-node` | ^3.x (última estável) | `server/package.json` | Lifecycle OAuth MS |

Zero dependências novas no frontend — o wizard usa `fetch` e
`useReducer`, nada de Zustand/novas libs.

## 6. Variáveis de ambiente novas

```bash
# server/.env
AZURE_CLIENT_ID=00000000-0000-0000-0000-000000000000   # mandatory no MVP
AZURE_TENANT_ID=common                                  # default common
# AZURE_CLIENT_SECRET não é necessário (public client + DAG)
# GOOGLE_* não é necessário no MVP
```

`IMAP_ENCRYPTION_KEY` continua a ser a mesma — é reutilizada para
`oauth_token_cache`.

**Validação no boot:** se existir algum `CurveConfig` com
`oauth_provider='microsoft'` e `AZURE_CLIENT_ID` estiver em falta, o
servidor falha-fast com erro claro.

## 7. O que este MVP **não** resolve

Para ser honesto sobre as limitações:

1. **Gmail continua em App Password.** Users que usam Gmail têm de
   criar uma app password (2FA + app passwords legacy) até à fase 2.
2. **Tenants O365 restritos.** Se o admin do tenant bloqueou IMAP ou
   public client flows, o wizard falha no step 2 e o user fica sem
   recurso. Documentação manual para contactar o admin.
3. **Re-auth é "todo o wizard outra vez".** No MVP não há entry point
   dedicado que salte steps 0/1 — user refaz o wizard completo. Fase 2
   adiciona `?reauth=1&email=X` (§5.7 do V2).
4. **Sem observabilidade avançada.** Métricas de flow completion rate,
   taxa de re-auth, etc., só entram quando houver dados suficientes
   para analisar.
5. **Mid-flow refresh perde state.** User que fizer F5 a meio do wizard
   cai no step 0. Aceitável dado que o wizard é curto.

Nada disto é "errado" — é consciente. Se algum destes pontos se revelar
bloqueante durante o smoke, subimos para MVP; caso contrário, ficam
como fase 2.

---

## 8. Critérios de aceitação

O MVP está pronto quando **todos** os critérios abaixo forem
verificáveis:

- [x] Existing user com App Password continua a sincronizar sem
      intervenção, sem warnings novos nos logs
      <!-- verified-by-code-review 2026-04-17: createImapReader
           routes legacy configs via imapReader.js:490-493; CurveLog
           enum não dispara oauth_* para oauth_provider=null;
           DashboardPage needsReauth curto-circuita em
           !oauthStatus?.provider; crypto.decrypt(null) é seguro. -->

- [x] Novo user cria conta, abre `/curve/setup`, completa o wizard até
      ao fim, e a primeira sync insere expenses sem intervenção manual
      <!-- fixed 2026-04-17: dois gaps bloqueantes identificados e
           corrigidos antes da verificação poder passar:
           (a) server/src/routes/curve.js PUT /config agora arranca
               o scheduler quando sync_enabled=true e ele ainda não
               está a correr — o boot-time auto-start em index.js só
               armava o cron se já existisse uma config sync_enabled
               antes do boot, pelo que um primeiro user nunca
               disparava syncs automáticas sem restart;
           (b) client/src/pages/CurveSetupPage.jsx handleFinish agora
               chama triggerSync() fire-and-forget se syncEnabled=true
               no step 6. Respeita o consentimento do user: se ele
               optou por sync manual (syncEnabled=false), nada é
               disparado. Isto garante que o happy-path do critério
               "primeira sync sem intervenção manual" não depende do
               próximo tick do cron (até 5 min). -->

- [ ] Sync >1h depois do setup inicial dispara refresh silencioso
      (observável em `CurveLog` via `oauth_token_refreshed`)
- [ ] Cache `oauth_token_cache` apagado à mão na DB → próximo sync
      marca `last_sync_status=error` + banner no dashboard
- [ ] Clicar no banner leva ao wizard e a re-autorização recupera a sync
- [ ] `CurveLog` tem entradas para `oauth_flow_started`,
      `oauth_flow_completed` com `accountId`
- [ ] Segundo user (conta diferente) faz o mesmo percurso sem colisões
      de cache

Estes são os sinais de que a arquitectura multi-user sem proxy do V2
está viável em produção. Uma vez verificados, o MVP cumpre a sua função
— destravar onboarding — e a fase 2 pode arrancar em cima de base
estável.

---

## 9. Relação com documentos existentes

- [`EMAIL_AUTH.md`](./EMAIL_AUTH.md) — **fonte de verdade arquitectural**;
  este MVP é um subset de âmbito, não uma alternativa
- V1 legacy (`email-oauth2-proxy`) — a documentação dedicada
  (`EMAIL_AUTH_V1_PROXY.md` + `email-oauth2-proxy.service`) foi
  apagada no sprint pós-PR 7, uma vez que o V2 é a única implementação
  suportada. Referências históricas vivem inline em `EMAIL_AUTH.md`
- [`EMAIL.md`](./EMAIL.md) — pipeline geral de ingestão de emails;
  inalterado pelo MVP (o único ponto de contacto é o `imapReader.js`
  refactor do PR 4)

Quando o MVP estiver completo e estável em produção, este documento
pode ser arquivado como "histórico da primeira onda" e o trabalho de
fase 2 passa a referenciar directamente o `EMAIL_AUTH.md`.
