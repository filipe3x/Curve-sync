# ROADMAP

Plano de evolução do Curve Sync, organizado por prioridade. Baseado nos TODOs documentados em `docs/expense-tracking.md` e no estado actual do esqueleto.

---

## Fase 1 — Fundação (Prioridade Alta) ✅

### ~~1.1 Pipeline de parsing de emails (cheerio)~~ ✅
Portar a lógica do `curve.py` (BeautifulSoup) para JavaScript/cheerio. Extrair `entity`, `amount`, `date`, `card` a partir do HTML dos emails Curve usando os selectores CSS originais (`td.u-bold`, `td.u-greySmaller.u-padding__top--half`, `td.u-padding__top--half`). Adicionar selectores fallback para resiliência caso o Curve mude o template.

- **Implementado:** `server/src/services/emailParser.js`

### ~~1.2 Leitor IMAP directo~~ ✅
Implementar ligação IMAP directa (substituindo offlineimap) para ler emails da pasta configurada. Usar a flag `UNSEEN` para saber quais emails já foram processados. Marcar como `Seen` apenas após processamento com sucesso. Inclui safety net `imap_since` (SEARCH UNSEEN SINCE) + `max_emails_per_run` (hard cap 500) para evitar first-sync massivo.

- **Implementado:** `server/src/services/imapReader.js`

### ~~1.3 Orquestrador de sincronização~~ ✅
Serviço que coordena: ligar IMAP → buscar emails não lidos → parsing → calcular digest → verificar duplicados → inserir despesa → criar log → marcar email como lido. Trata erros por email individualmente. Inclui circuit breaker (10 parse errors consecutivos), summary.error surfacing, e capped flag.

- **Implementado:** `server/src/services/syncOrchestrator.js`

### ~~1.4 Smart folder picker~~ ✅
Dropdown de pasta IMAP populado pelo servidor (POST /test-connection), com banner de confirmação, auto-save debounced, suporte para valores stale, e auto-invalidação via orchestrator em code=FOLDER.

- **Implementado:** `CurveConfigPage.jsx`, `CurveConfig.imap_folder_confirmed_at`

### 1.5 Autenticação e Multi-User Support
→ Ver **secção dedicada "Multi-User Support"** abaixo — detalha 5 fases desde auth middleware até scheduler per-user.

---

## Fase 2 — Funcionalidade Completa (Prioridade Média)

### 2.1 Cycle-aware `imap_since` (dia 22)
Substituir o fallback estático de 31 dias por uma data computada dinamicamente a partir do ciclo mensal de despesas (dia 22, alinhado com o ciclo salarial):

- Se hoje ≥ 22 deste mês → `since` = dia 22 deste mês
- Se hoje < 22 deste mês → `since` = dia 22 do mês anterior
- Fuso horário: **Europe/Lisbon** (nunca UTC)

Expor no frontend como campo configurável em `CurveConfigPage.jsx` para o utilizador definir o dia de corte do mês (default 22). A infra de timezone (`defaultSince()` com `Intl.DateTimeFormat`) já existe em `imapReader.js`.

- **Schema:** `CurveConfig.sync_cycle_day: Number, default: 22`
- **Referência:** `CLAUDE.md` → Custom Monthly Cycle
- **Referência:** `docs/EMAIL.md` → First-sync safety net

### 2.2 Relatórios mensais com ciclo dia 22
Endpoint `GET /api/expenses/monthly` que agrupa despesas pelo ciclo customizado (22 do mês → 21 do mês seguinte). Devolver totais por mês e variação percentual entre meses.

- **Referência:** `docs/expense-tracking.md` — secção "Ciclo Mensal Personalizado"
- **Referência:** `docs/embers-reference/controllers/expenses_controller.rb` — `monthly_expenses`

### 2.3 Savings Score semanal
Endpoint `GET /api/expenses/savings-score` que calcula:
- Orçamento semanal: €295 / 4
- Score: `(log(weekly_savings + 1) / log(budget + 1)) * 10`
- Devolver: score (0–10), despesas da semana, orçamento restante

### 2.4 Validação de campos extraídos
Antes de inserir uma despesa, validar: entity não vazia, amount numérico e positivo, date parseável. Se a validação falha, criar `CurveLog` com status `parse_error` e guardar o HTML truncado em `error_detail`.

### 2.5 Dashboard com dados reais
Ligar os `StatCard` do Dashboard a dados reais: total do mês (ciclo 22), savings score, emails processados, estado do último sync. Actualmente mostram placeholders.

### 2.6 Filtros avançados na listagem de despesas
Filtros por: categoria, cartão, intervalo de datas, entidade. Ordenação por data ou entidade (asc/desc). O frontend já tem a estrutura; falta implementar os query params no backend.

### 2.7 Encriptação de credenciais IMAP
As passwords IMAP são guardadas em texto simples no `curve_configs`. Encriptar com AES-256 antes de guardar e desencriptar apenas no momento da ligação.

---

## Fase 3 — Polimento (Prioridade Baixa)

### 3.1 Layout responsivo / mobile
A sidebar fixa não funciona em ecrãs pequenos. Adicionar drawer colapsável ou bottom nav para mobile.

### 3.2 Notificações / Toasts
Feedback visual para acções: sync concluído (X importadas, Y duplicadas, Z erros), config guardada, erro de ligação. Usar toasts com fade-out automático.

### 3.3 Dark mode
Suporte a tema escuro usando as variáveis CSS do Tailwind. O design monocromático adapta-se bem.

### 3.4 Exportação de despesas
Permitir exportar despesas filtradas em CSV ou JSON.

### 3.5 Gestão de categorias
Visualizar categorias e as entidades associadas. Permitir associar manualmente uma entidade a uma categoria (o Embers é owner, mas a visualização é útil).

### 3.6 Reprocessamento de emails com erro
Na página de Logs, permitir re-trigger do parsing para logs com status `parse_error` ou `error`.

### 3.7 Testes
- Testes unitários do parser cheerio com fixtures de emails `.eml`
- Testes do serviço `expense.js` (digest, auto-category)
- Testes de integração dos endpoints Express

### 3.8 Docker
`Dockerfile` + `docker-compose.yml` para facilitar deploy (Curve Sync + MongoDB, ou apenas Curve Sync apontando para MongoDB externo).

---

## Multi-User Support

Secção dedicada à evolução de single-user para multi-user. Substitui os antigos items 1.5/1.6.

### Estado actual

| Camada | Multi-user pronto? | Notas |
|--------|-------------------|-------|
| **Schemas (modelos)** | ✅ Sim | `user_id` required em `Expense`, `CurveConfig` (unique), `CurveLog` |
| **Sync Orchestrator** | ✅ Sim | Recebe `config.user_id`, valida-o, usa-o em todos os writes; lock per-user via `Set` |
| **Routes (API)** | ✅ Sim | Todos os endpoints filtram por `req.userId` via middleware authenticate |
| **Auth middleware** | ✅ Sim | Bearer token → Session lookup → `req.userId`; session expiry 1 dia |
| **Frontend** | ✅ Sim | AuthContext, LoginPage, ProtectedRoute, 401 auto-logout |
| **Cron/Scheduler** | ✅ Sim | `node-cron` itera configs com `sync_enabled: true`; auto-start no boot |
| **Hardening** | ✅ Sim | AES-256-GCM para IMAP passwords, rate limiting, CORS, audit logging |

### MU-1 — Auth Foundation (backend)

Criar a camada de autenticação. Opção escolhida: **login próprio replicando o hash SHA-256 do Embers** (ver `docs/AUTH.md` Opção 1).

- [x] **Modelo Session** — `server/src/models/Session.js` (read-write, `strict: false`, collection `sessions`)
- [x] **Actualizar modelo User** — campos `encrypted_password` e `salt` (read-only)
- [x] **Serviço auth** — `server/src/services/auth.js` com `sha256()` e `verifyPassword(password, salt, encryptedPassword)`
- [x] **Middleware authenticate** — `server/src/middleware/auth.js`: extrai Bearer token → lookup Session → define `req.userId`
- [x] **Routes auth** — `server/src/routes/auth.js`: `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`

**Dependências:** Nenhuma — pode ser desenvolvido de forma independente.
**Referência:** `docs/AUTH.md` (código quasi-pronto para cada peça).

### MU-2 — Route Scoping (backend)

Aplicar o middleware `authenticate` a todas as routes e fazer scoping por `req.userId`.

- [x] **GET /api/expenses** — `{ user_id: req.userId }` no filter
- [x] **POST /api/expenses** — usa `req.userId` em vez de `req.body.user_id`
- [x] **GET /api/curve/config** — `CurveConfig.findOne({ user_id: req.userId })`
- [x] **PUT /api/curve/config** — `findOneAndUpdate({ user_id: req.userId }, ...)`; email→user lookup removido
- [x] **POST /api/curve/sync** — `CurveConfig.findOne({ user_id: req.userId })`
- [x] **GET /api/curve/sync/status** — idem
- [x] **POST /api/curve/test-connection** — idem
- [x] **GET /api/curve/logs** — `CurveLog.find({ user_id: req.userId })`; suporta `?type=audit|sync`
- [x] **GET /api/autocomplete/:field** — `Expense.distinct(field, { user_id: req.userId })`

**Dependências:** MU-1 (middleware authenticate).

### MU-3 — Frontend Auth

Adicionar login/logout e protecção de rotas no frontend.

- [x] **AuthContext** — `client/src/contexts/AuthContext.jsx`: estado `user`/`token`, persist em `localStorage`, `login()`/`logout()`
- [x] **API interceptor** — `client/src/services/api.js`: `Authorization: Bearer <token>` em todos os pedidos; 401 → auto-logout via custom event
- [x] **LoginPage** — `client/src/pages/LoginPage.jsx`: form email + password → `POST /api/auth/login`
- [x] **ProtectedRoute** — wrapper em `App.jsx` que redireciona para `/login` se não autenticado
- [x] **App.jsx** — routes envolvidas em AuthContext + ProtectedRoute
- [x] **Layout** — email do utilizador + role na sidebar; botão logout

**Dependências:** MU-1 (endpoints auth), MU-2 (routes protegidas retornam 401 sem token).

### MU-4 — Per-User Sync e Scheduler

Tornar o sync concorrente entre utilizadores e implementar o cron scheduler.

- [x] **Lock per-user** — `syncOrchestrator.js`: `const running = new Set()` de `config._id`; `running.has()` / `running.add()` / `running.delete()`
- [x] **Unique index composto** — `{ digest: 1, user_id: 1 }` em `Expense` (mantém compatibilidade com curve.py)
- [x] **Scheduler** — `server/src/services/scheduler.js`: `node-cron` 5min; itera configs com `sync_enabled: true`; skip se lock activo
- [x] **Routes scheduler** — `POST start`, `POST stop`, `GET status`
- [x] **Arranque automático** — scheduler inicia no boot se existirem configs com `sync_enabled: true`

**Dependências:** MU-2 (routes scoped); MU-1 (auth para rotas admin).

### MU-5 — Hardening

Segurança e robustez para ambiente multi-user em produção.

- [x] **Encriptação IMAP passwords** — AES-256-GCM at rest; decrypt on-the-fly para IMAP; chave em `IMAP_ENCRYPTION_KEY`; backwards-compat com plaintext
- [x] **Rate limiting** — `express-rate-limit`: login 10/15min, sync 3/min, API 100/min
- [x] **Session expiry** — TTL 1 dia via `expires_at` + lazy cleanup no middleware (sem TTL index — collection partilhada com Embers)
- [x] **Audit logging** — login/logout/session_expired/config_updated/password_changed/sync_manual → `curve_logs` com IP; `?type=audit` filter
- [x] **CORS restritivo** — `CORS_ORIGIN` env var; lista de origens separadas por vírgula

**Dependências:** MU-1 a MU-4 concluídas.

### Impacto nos recursos do servidor

| Recurso | Impacto (5–20 users) | Mitigação |
|---------|----------------------|-----------|
| Conexões IMAP | 1 conexão por sync (~10-30s cada); serializado = sem pico | Scheduler sequencial (FIFO) |
| Memória | `async *fetchUnseen()` já é generator — 1 email de cada vez | Nenhuma mudança necessária |
| MongoDB | 1× `Category.find()` cache por run + N inserts | Negligível |
| CPU (cheerio) | ~1-5ms por email parse | Negligível |
| Cron overhead | 1 timer `node-cron` + iteração por configs | Zero overhead extra vs single-user |

**Para 100+ users (improvável):** promover para BullMQ + Redis (queue com 2-3 workers concorrentes) e lock Mongo-level (`findOneAndUpdate` atómico em `is_syncing`).

---

## Decisões técnicas em aberto

| Questão | Opções | Notas |
|---------|--------|-------|
| ~~Autenticação~~ | ~~API key simples vs JWT vs sessão partilhada com Embers~~ | **Decidido:** Login próprio com SHA-256 do Embers (Opção 1 do `AUTH.md`) |
| IMAP library | `imapflow` vs `node-imap` | `imapflow` é mais moderno e mantido |
| Scheduler | `node-cron` (in-process) vs `bull` + Redis (queue) | `node-cron` suficiente para single-instance; `bull` se precisar de retry/concurrency |
| Password encryption | `crypto.createCipheriv` (AES-256-GCM) | Chave de encriptação em variável de ambiente |
