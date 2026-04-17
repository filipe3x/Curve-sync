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

### ~~1.5 Autenticação e Multi-User Support~~ ✅
→ Ver **secção dedicada "Multi-User Support"** abaixo — 5 fases completas (MU-1 a MU-5).

---

## Fase 2 — Funcionalidade Completa (Prioridade Média)

### ~~2.1 Cycle-aware `imap_since` (dia 22)~~ ✅
Substituído o fallback estático de 31 dias por uma data computada dinamicamente a partir do ciclo de despesas do utilizador (default dia 22, configurável 1–28 per-user). O scope final ficou global: o mesmo `sync_cycle_day` alimenta o `imap_since` fallback, o dashboard, `/categories/stats` e `/curve/stats/uncategorised`.

- **Implementado:**
  - `server/src/services/cycle.js` — `cycleBoundsFor(anchor, cycleDay=22)`, `normaliseCycleDay` (clamp [1,28] para evitar overflow em Fevereiro), `getUserCycleDay(userId)`, `cycleBoundsForUser(userId)`
  - `server/src/models/CurveConfig.js` — campo `sync_cycle_day: Number, default: 22, min: 1, max: 28`
  - `server/src/routes/curve.js` — PUT `/config` aceita `sync_cycle_day` (omitido = mantém valor anterior; clamp no escrita via `normaliseCycleDay`)
  - `server/src/services/imapReader.js` — `defaultSince(config)` retorna o início do ciclo actual do user em vez de 31 dias fixos; signature sem args mantém fallback 31d para retrocompatibilidade
  - `server/src/routes/categories.js` + `server/src/routes/curve.js` — endpoints `/stats` e `/stats/uncategorised` resolvem `cycleDay` per-user antes de calcular bounds
  - `client/src/pages/CurveConfigPage.jsx` — dropdown 1–28 logo abaixo do intervalo de sync, com copy explicativo
- **Testes:** `server/test/cycle.test.js` (15 casos: defaults, cycleDay=1/28, boundaries de ano, leap year Fevereiro, validação) + `server/test/defaultSince.test.js` (5 casos)
- **Referência:** `CLAUDE.md` → Custom Monthly Cycle
- **Referência:** `docs/EMAIL.md` → First-sync safety net

### 2.2 Relatórios mensais com ciclo dia 22 — 🔵 baixa prioridade / adiado

**Adiado em favor da §2.8** (gráfico evolutivo por ciclo). O `computeCycleHistory` da §2.8 produz exactamente a mesma informação — totais por ciclo + variação percentual face ao ciclo anterior — já serializado para consumo directo pelo frontend. Um endpoint `GET /api/expenses/monthly` separado duplicaria a agregação e abriria dois caminhos para manter em sync sempre que o formato do `Expense.date` mudasse.

**Reabre-se quando:**
- Houver um consumidor externo (script, export CLI, relatório imprimível) que precise do relatório fora do flow do dashboard
- A §2.8 mostre que o volume de payload do `meta.cycle_history` é problemático e valha a pena separar os dois endpoints

**Se for reabrir**, a implementação directa é envolver `computeCycleHistory` num handler `router.get('/monthly', ...)` de `routes/expenses.js`.

- **Referência:** `docs/expense-tracking.md` — secção "Ciclo Mensal Personalizado"
- **Referência:** `docs/embers-reference/controllers/expenses_controller.rb` — `monthly_expenses`

### ~~2.3 Savings Score semanal~~ ✅ *(fechado via 2.5)*

Não foi criado um endpoint dedicado `GET /api/expenses/savings-score` — a fórmula e os campos que ele devolveria já são expostos no `meta` de `GET /api/expenses` desde a Fase 2.5. Um endpoint separado duplicaria o mesmo cálculo para zero ganho actual. O conceito, no entanto, está implementado e visível no dashboard.

**Como é calculado** (canonical em `server/src/services/expenseStats.js:computeSavingsScore`):

```
weekly_budget    = config.weekly_budget (default €73,75 = €295 / 4)
weekly_expenses  = soma de Expense.amount nos últimos 7 dias rolling
weekly_savings   = weekly_budget − weekly_expenses
score            = (log(weekly_savings + 1) / log(weekly_budget + 1)) * 10
                   clamped a [0, 10], arredondado a 1 decimal
```

A escala é **logarítmica** por design: psicologicamente, gastar €60 de €73,75 já é quase rebentar o orçamento e não deve render 80 % do score máximo; a curva log recompensa poupanças pequenas mais rapidamente e achata perto do tecto.

**Exemplos trabalhados (budget €73,75):**

| Gasto | Poupança | Score | Notas |
|-------|----------|-------|-------|
| €73,75 | €0,00 | 0,0 | orçamento todo consumido |
| €60,00 | €13,75 | 6,1 | |
| €50,00 | €23,75 | 7,3 | |
| €42,11 | €31,64 | 8,1 | exemplo canónico que aparece na UI |
| €20,00 | €53,75 | 9,3 | |
| €0,00 | €73,75 | 10,0 | nada gasto → tecto |
| €90,00 | −€16,25 | 0,0 | overspend → colapsa para 0 |

**O que o dashboard mostra:**

- **Valor do StatCard**: o score (ex. `8.1`)
- **Sub-label**: `Poupança 31,64 € · orçamento 73,75 €` quando savings ≥ 0, ou `Excedeste o orçamento em 16,25 €` quando overspend. Substituiu a forma anterior `31,64 € / 73,75 €` que os utilizadores liam como "gastei 31 de 74" quando o significado era o inverso
- **Tooltip (`title`)** no próprio card: "Score de 0 a 10 baseado no que poupaste esta semana face ao orçamento. Escala logarítmica — poupar pouco já dá score alto; gastar tudo colapsa para 0."

**Se um consumidor externo (script, export, CLI) precisar do score isolado**, é trivial envolver `computeDashboardStats` num handler `router.get('/savings-score', ...)` — o helper já existe e é pure.

- **Referência:** `server/src/services/expenseStats.js` → `computeSavingsScore`

### ~~2.4 Validação de campos extraídos~~ ✅

Segunda barreira de validação entre o parser e `Expense.create`: o parser já lança `ParseError` para campos estruturalmente em falta; agora há um gate adicional que rejeita valores **aceites pelo parser mas nonsensicais** (entity vazia após trim, amount NaN/Infinity/zero, date que `Date.parse` não reconstrói). Log `parse_error` com `error_detail` a incluir o campo que falhou + razão + snippet HTML (200 chars, sem newlines, com fast-forward ao `<!doctype html>`). Email fica UNSEEN para retry.

- **Implementado:**
  - `server/src/services/emailParser.js` — `validateParsed(parsed)` pura, retorna `{ ok: true } | { ok: false, field, reason }`
  - `server/src/services/syncOrchestrator.js` — novo step 1b entre parse e categorise; respeita o mesmo circuit breaker (10 parse/validation errors consecutivos sem `ok` → halt). Novo helper `truncateHtml(raw, 200)` para o snippet de contexto
- **Desvio da spec ROADMAP:** "amount positivo" foi alargado a "amount finito não-zero" para não descartar refunds (Curve emite reembolsos com `amount` negativo — ver docstring de `parseAmount`). Rejeitamos 0, NaN, ±Infinity
- **Testes:** `server/test/validateParsed.test.js` (15 casos: happy path, refund accepted, entity empty/whitespace/non-string, amount NaN/Infinity/zero/string, date empty/unparseable/whitespace, null/undefined parsed, missing card still passes)

### ~~2.5 Dashboard com dados reais~~ ✅
Os `StatCard` do Dashboard passaram de placeholders `—` a KPIs reais, alinhados com o ciclo configurável do utilizador (§2.1). Quatro cartões vivos:

| Card | Fonte |
|------|-------|
| Despesas este mês | Soma `Expense.amount` dentro do ciclo actual; sub-label mostra `YYYY-MM-DD → YYYY-MM-DD` |
| Savings Score | Fórmula Embers `(log(weekly_savings + 1) / log(budget + 1)) * 10`, janela 7d rolling, clamped [0, 10] |
| Sem categoria | Count `CurveLog` com `uncategorised=true` no ciclo (já pré-existente) |
| Último sync | `formatRelativePt(last_sync_at)` com sub-label de `emails_processed` |

- **Implementado:**
  - `server/src/services/expenseStats.js` — puro, injectável-para-testes: `parseExpenseDate`, `computeSavingsScore(weeklySavings, weeklyBudget)`, `computeDashboardStats({ userId })`
  - `server/src/models/CurveConfig.js` — novo campo `weekly_budget: Number, default: 73.75` (€295/4), exposto como input editável em `/curve/config` com parsing tolerante (aceita `73,75` e `73.75`) e clamp `≥ 0`
  - `server/src/routes/expenses.js` — `GET /api/expenses` devolve `meta` estendido com `month_total`, `savings_score`, `weekly_*`, `last_sync_at`, `last_sync_status`, `emails_processed`, `cycle`; falha do `computeDashboardStats` colapsa a `null` em vez de 500ar a listagem
  - `client/src/pages/DashboardPage.jsx` — `Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' })` para amounts e formatter relativo pt manual ("há X min/h/d") em vez de `Intl.RelativeTimeFormat` (rounding demasiado aggressive para cadência de sync)
  - `client/src/pages/CurveConfigPage.jsx` — campo `weekly_budget` (input number, save on blur, copy explicativo)
- **Testes:** `server/test/expenseStats.test.js` (13 casos: savings score edge cases incluindo budget zero e overspend, `parseExpenseDate` defensivo, agregação com cycleDay 1 e 22, custom budget, no-config fallback, string amounts coerced)
- **Decisões:**
  - Preferiu-se estender o `meta` de `/expenses` em vez de endpoint `/stats/dashboard` dedicado — evita 2ª round-trip no mount do dashboard (já chama `getExpenses({ limit: 5 })`)
  - Janela semanal é rolling 7d (`now - 7 * 86400s`), não Monday-Sunday ISO, porque o user perguntado quer "quanto poupei estes últimos dias" não "esta semana calendário"
  - Não se usou `mongoose.aggregate` — a agregação em JS cobre o volume realista (centenas de expenses/mês por user) e partilha o `parseExpenseDate` com `/categories/stats`

### ~~2.6 Filtros avançados na listagem de despesas~~ ✅ *(backend only)*

Query params novos em `GET /api/expenses` — **todos opcionais, todos aditivos**, frontend legacy continua a funcionar sem alterações (só manda `page/limit/search/sort` como antes):

| Param | Semântica | Notas |
|-------|-----------|-------|
| `card` | Match exacto em `Expense.card` | Frontend deve vir da autocomplete (já canónico) |
| `entity` | Match exacto em `Expense.entity` | Idem |
| `start` | `YYYY-MM-DD` lower bound inclusivo em `Expense.date` | Mongo-side via `$expr` + `$dateFromString` |
| `end` | `YYYY-MM-DD` upper bound inclusivo em `Expense.date` | Idem |
| `sort` | Allowlist `date`/`amount`/`entity`/`card`/`created_at` ± | Campos fora da lista colapsam para `-date` |
| `search` (legacy) | Regex `i` sobre `entity`+`card` | **Agora escapa metachars** para evitar catastrophic backtracking |

- **Implementado:**
  - `server/src/routes/expenses.js` — `escapeRegex` helper (security fix acoplado ao 2.6), `sanitiseSort` com allowlist, parsing + validação por param, `$expr`+`$dateFromString` para range de datas (rejeita silenciosamente rows com formato não reconstruível)
- **Scope cut consciente (UI fica para outro PR):**
  - `ExpensesPage.jsx` mantém a estrutura actual — não adicionei selects para `card`/`entity`/`start`/`end` porque o utilizador pediu explicitamente "sem disrupção da interface actual"
  - A API está pronta; o frontend pode ligar incrementalmente (e.g. chip de entity na autocomplete, datepicker para range)
- **Testes:** `server/test/expenseFilters.test.js` (8 casos: `sanitiseSort` defaults + allowlist + injection attempt, `escapeRegex` metachars + catastrophic-backtracking probe)
- **Impacto no build:** frontend unchanged (`vite build` = 471 kB unchanged). Backend: 7 novos testes, 0 regressão

### ~~2.7 Encriptação de credenciais IMAP~~ ✅
Movido para MU-5 e implementado: AES-256-GCM at rest, decrypt on-the-fly, backwards-compat com plaintext. Ver `server/src/services/crypto.js`.

### 2.8 Gráfico evolutivo agregador por ciclo 📈 — **tracked em PR separado**

> **Scope cut deste PR:** a especificação abaixo fica documentada; a implementação (instalar `recharts`, criar `computeCycleHistory`, compor `CycleTrendCard`) é feita num PR dedicado porque o bundle-size impact (~55–65 kB gzip) e a verificação de `prefers-reduced-motion` justificam uma revisão de UI focada.

Adicionar ao dashboard um gráfico que mostre, ciclo-a-ciclo, o consumo total em EUR e destaque visualmente os altos e baixos entre ciclos consecutivos — i.e., quanto se gastou a mais ou a menos do ciclo anterior para o seguinte. O objectivo é responder de relance a «estou a gastar mais ou menos do que há 3 meses?» sem ter de abrir `/expenses`.

**Requisitos funcionais:**

- Histórico mínimo: últimos **12 ciclos** (≈ 1 ano), adaptável conforme volume disponível
- Cada ciclo é rotulado pelo início (`22 Mar`) e pela janela curta (`Mar 22 → Abr 21`) num tooltip
- Barras verticais com o total de cada ciclo em EUR
- **Delta inter-ciclo** claramente visível:
  - Cor da barra: verde se `total < ciclo anterior` (poupou), vermelho-curve se `total > ciclo anterior` (gastou mais), neutro no primeiro ciclo
  - Sub-label por barra: `↓ €X,XX` ou `↑ €Y,YY` vs ciclo anterior, com percentagem
- Linha fina sobreposta com a **média móvel** dos últimos 3 ciclos para suavizar ruído mensal
- Clicar numa barra → deep-link para `/expenses?start=<cycleStart>&end=<cycleEnd>` (já suportado pela Fase 2.6 quando aterrar)
- Responsivo (SSR-safe): o ponto de entrada é `DashboardPage`, que carrega entre a secção dos StatCards e as despesas recentes

**Stack proposta:**

| Peça | Opção | Porquê |
|------|-------|--------|
| Biblioteca de charts | [`recharts`](https://recharts.org/) (`^2.x`) | React-native composable API, tree-shakeable (~55 kB gzip com o subset que usamos: `BarChart`, `ComposedChart`, `Bar`, `Line`, `Tooltip`, `CartesianGrid`, `XAxis`, `YAxis`, `Cell`); SVG puro (sem canvas/WebGL), portanto funciona bem com prefers-reduced-motion e acessibilidade; usado no ecossistema Embers-adjacente |
| Alternativa descartada | `chart.js` + `react-chartjs-2` | Maior bundle (~80 kB), canvas (pior a11y), API imperativa mais distante do React flow |
| Alternativa descartada | `@visx/*` (Airbnb) | D3-level control, mas obriga a compor cada eixo/escala à mão — muito para um single chart no MVP |
| Alternativa descartada | `victory` | Fica prolixo para barras coloridas condicionalmente; tooltip customizado requer workarounds |
| Formatação EUR | Reutilizar `Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' })` já inline em `DashboardPage` | Zero novas deps |
| Motion | Reutilizar `motion/react` (já no projecto) para fade-in da card quando `data` aterra | Consistência com os outros cards animados |
| Paleta | Tokens Tailwind existentes: `curve-600` (gasto), `emerald-500` (poupou), `sand-400` (neutro), `sand-300` (grid lines) | Sem novas cores |

**Estrutura de implementação:**

1. **Backend — agregação multi-ciclo**
   - Novo helper `computeCycleHistory({ userId, cycles = 12 })` em `server/src/services/expenseStats.js`, reutilizando `cycleBoundsFor` / `getUserCycleDay`:
     - Para cada um dos últimos `cycles` ciclos (walk-back a partir de hoje), devolve `{ cycle_start, cycle_end, cycle_label, total, expense_count }`
     - Single query: `Expense.find({ user_id, ... }).select('amount date').lean()` + classificação em JS (mesmo padrão de `computeDashboardStats`)
     - Pré-computa o **delta absoluto** e **delta %** vs ciclo imediatamente anterior
   - Exposição:
     - Opção A (preferida): estender `meta` de `GET /api/expenses` com `meta.cycle_history: [...]` — mantém o tracking single-endpoint do dashboard
     - Opção B: novo endpoint `GET /api/expenses/stats/cycles?count=12` se o payload ficar pesado (improvável com 12 linhas pequenas)
   - Cap de `cycles` ≤ 36 para defesa contra abuse
   - Fast-fail: se falhar, cair para `null` e o card renderiza "Sem histórico suficiente" como fez o uncategorised card

2. **Frontend — componente `CycleTrendCard`**
   - `client/src/components/dashboard/CycleTrendCard.jsx` — novo, isolado
   - Props: `{ history: Array<{ cycle_start, cycle_end, cycle_label, total, delta_absolute, delta_pct }>, cycleDay }`
   - Composição `recharts`:
     ```jsx
     <ComposedChart data={history}>
       <CartesianGrid stroke="sand-300" strokeDasharray="3 3" />
       <XAxis dataKey="cycle_label" tick={{ fontSize: 11 }} />
       <YAxis tickFormatter={EUR.format} />
       <Tooltip content={<CycleTooltip />} /> {/* delta + % + janela */}
       <Bar dataKey="total" radius={[4, 4, 0, 0]}>
         {history.map((row, i) => (
           <Cell fill={colorForDelta(row.delta_absolute)} key={i} />
         ))}
       </Bar>
       <Line dataKey="moving_avg_3" stroke="sand-600" dot={false} strokeWidth={1.5} />
     </ComposedChart>
     ```
   - `colorForDelta`: `null` → `sand-400`; `> 0` → `curve-600`; `< 0` → `emerald-500`
   - Tooltip customizado mostra: janela (`22 Mar → 21 Abr`), total, delta (`↑ €42,10 / +18% vs ciclo anterior`), expense_count

3. **Instalar a package**
   ```bash
   npm install --prefix client recharts
   ```
   Tamanho esperado no bundle client: +55–65 kB gzip (`BarChart` + `ComposedChart` + `Line` + `Tooltip` + `CartesianGrid` + `XAxis` + `YAxis` + `Cell`). Actual bundle actual é ~145 kB gzip, pelo que sobe ~40%. **Verificar `vite build` depois da instalação** — se ficar > 250 kB gzip, avaliar lazy-load com `React.lazy()` porque o gráfico só aparece na `/` (dashboard).

4. **Testes**
   - `server/test/cycleHistory.test.js` (novo) — casos:
     - 12 ciclos com expenses espalhadas → totals e deltas correctos
     - Menos de 12 ciclos de dados → devolve só os que existem (array curto)
     - Ciclo vazio no meio do histórico → total 0, delta vs anterior negativo
     - `cycleDay` diferente por user (22 vs 1) → janelas diferentes
   - `computeCycleHistory` é puro com override `expenses`/`now`/`config` tal como `computeDashboardStats`

5. **Copy / UX**
   - Título do card: **«Evolução por ciclo»** (com toggle `6m` / `12m` / `24m` no topo direito — opcional, fase 2)
   - Sub-label: **«Verde = gastaste menos que no ciclo anterior. Vermelho = gastaste mais.»**
   - Estado vazio (0 ou 1 ciclo de dados): ilustração + **«Regressa daqui a um ciclo para veres a tua tendência.»**
   - `prefers-reduced-motion` → desactivar `isAnimationActive` nos elementos `recharts`

**Riscos / considerações:**

- **Ciclo actual é móvel** — o "total do ciclo em curso" continua a mudar até ao próximo dia de corte. Marcar a última barra com um padrão hachurado (`pattern` em SVG) ou opacity reduzida para comunicar "em curso"
- **Expense.date é string** — o parser partilhado `parseExpenseDate` já trata; skip silencioso mantém-se
- **TZ boundaries** — todos os cálculos continuam UTC-anchored via `cycleBoundsFor`; nenhum código novo deve tocar no fuso
- **Accessibility** — `recharts` suporta `role="img"` + `aria-label`; adicionar uma tabela sr-only com os mesmos valores para screen readers (pattern standard `recharts` examples)

**Dependências:**

- Requer **2.1** (ciclo configurável) já implementada — deriva daí
- Beneficia, mas não depende, de **2.6** (filtros `/expenses` com `?start=&end=`) para tornar o deep-link das barras funcional; sem isso, o clique leva a `/expenses` com filtro em cliente

**Referências:**

- `docs/expense-tracking.md` → Savings Score (fórmula já canónica)
- `CLAUDE.md` → Custom Monthly Cycle
- Fase 2.5 deste roadmap — mesma pipeline de `computeDashboardStats` estende-se a `computeCycleHistory`

---

## Fase 3 — Polimento (Prioridade Baixa)

### ~~3.1 Layout responsivo / mobile~~ ✅

Sidebar agora é **um único componente responsivo** que colapsa para um rail de ícones (64 px) em narrow (`< lg / 1024 px`) e expande para sidebar full (256 px) em wide. Em portrait/phone fica visível apenas o badge "CS" no topo + os 5 ícones de navegação empilhados verticalmente + botão de logout no fundo. Sem drawer, sem hamburger, sem topbar — cada destino está a um tap.

**Iteração:** a primeira implementação foi um slide-in drawer com hamburger + wordmark no topbar. Revertida após feedback de que o topbar portrait mostrava `CS` e `Curve Sync` lado-a-lado (redundância visual) e porque cada navegação forçava dois taps (hamburger → link). O rail sempre-visível resolve ambos.

- **Implementado:**
  - `client/src/components/layout/Sidebar.jsx` — único componente, `w-16 lg:w-64`; brand vira só badge em mobile (`hidden lg:inline` no wordmark); NavLinks alternam entre `justify-center` (icon-only) e `justify-start` (icon + label); cada link carrega `title={label}` + `aria-label={label}` para tooltips + screen readers
  - `client/src/components/layout/Shell.jsx` — simplificado para `<div className="flex min-h-screen"><Sidebar /><main>…</main></div>`; removido todo o state do drawer (escape listener, body scroll lock, backdrop, `useLocation` auto-close) — ~60 linhas de complexidade desapareceram
  - `client/src/contexts/ToastContext.jsx` — viewport dos toasts ancorado a `top-right` em todos os breakpoints (ajustado para não brigar com o rail lateral ocupado)
  - `min-w-0` no `<main>` previne que tabelas largas (`/expenses`, `/curve/logs`) expandam o viewport lateralmente no telemóvel (flex default é `min-width: auto`)
- **Acessibilidade:**
  - Nav container é `<aside aria-label="Navegação">`
  - Links icon-only mantêm `aria-label` com o nome canónico — screen readers anunciam "Dashboard" / "Despesas" / ... igual em ambos os modos
  - `title` attribute fornece tooltip nativo em desktop ao passar o cursor sobre o ícone
- **Ajustes afinados em cima do rail:**
  - Botão «Sincronizar agora» do dashboard vira só ícone em `< lg` (`<span className="hidden lg:inline">` sobre o texto); `aria-label` + `title` mantêm o nome completo para assistive tech e tooltips
  - Ícone `ArrowPathIcon` do mesmo botão subiu de `h-4 w-4` para `h-5 w-5` em ambos os modos — lê-se como glyph de acção em vez de token
- **Impacto no bundle:** zero deps novas; código net-negativo vs iteração do drawer (saíram state, listeners e scroll lock)
- **🔬 Testes de campo pendentes (follow-up, ajustes minor):**
  - [ ] **iPhone SE 1ª gen (320 × 568)** — o mais estreito ainda em circulação; verificar que o rail de 64 px + main column não força scroll horizontal em `/expenses` nem em `/curve/logs`
  - [ ] **iPhone 12/13/14 mini (375 × 667)** — alvo típico de portrait; confirmar o gap entre o botão «Sincronizar» e o título no `PageHeader` (actualmente sem breakpoint intermédio)
  - [ ] **iPhone 14 Pro Max (430 × 932)** — verificar que o rail não parece anémico num ecrã maior onde ainda estamos abaixo de `lg`
  - [ ] **iPad mini portrait (768 × 1024)** — **zona crítica**: ainda abaixo do breakpoint `lg` de 1024 px, portanto cai no rail mobile. Avaliar se a partir de `md` (768 px) vale a pena introduzir um breakpoint intermédio com rail + labels (ex: `w-48`), ou manter o rail slim e expandir apenas acima de `lg`
  - [ ] **iPad Pro 11" landscape (1194 × 834)** — landscape tablets já entram em sidebar full; validar que a sidebar não come espaço demais em landscape
  - [ ] **Android Chrome (Pixel 7, Galaxy S22)** — verificar `safe-area-inset-bottom` na navegação (actualmente não aplicado) e comportamento do `title` tooltip em touch
  - [ ] **Orientation flip** (portrait → landscape num phone) — confirmar que nada se partiu; o layout é CSS-only, portanto deve adaptar-se sem glitch
  - [ ] **Tema do sistema dark** (browser dev tools) — o dark mode está diferido para §3.3, mas verificar que o rail actual não fica ilegível em dark via `forced-colors`
  - [ ] **Toasts em mobile** — validar que não sobrepõem o `PageHeader` com 2+ toasts simultâneos; ajustar `top-3` se necessário
  - [ ] **Tap targets** — passar pelo [WCAG 2.2 Target Size (AAA ≥ 44 px)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html); botão de logout e hamburger dos ícones de nav estão na fronteira (`p-2.5` + `h-5` = 36 px), pode valer a pena subir para `p-3`

  **O que não é pendente nestes testes:** a arquitectura (rail sempre-visível vs drawer) está decidida. Os ajustes esperados são todos CSS tweaks — paddings, breakpoints intermédios, `safe-area-inset`. Nenhum deles deve mover código para fora do `Sidebar.jsx`/`Shell.jsx`.

### ~~3.2 Notificações / Toasts~~ ✅

Sistema de toasts próprio (sem lib externa — `sonner`/`react-hot-toast`/`radix-toast` descartadas por trazerem 2–5 kB gzip cada para uma API que não usamos). Três tons (`success` / `error` / `info`), 3 call-sites iniciais:

| Call-site | Toasts emitidos |
|-----------|-----------------|
| `DashboardPage` — "Sincronizar agora" | `success` com o `summary` do server, ou `error` com a razão (mantém inline banner por redundância) |
| `CurveConfigPage` — test connection, folder save, dismiss banner, schedule save, budget save | `success` e `error` com id estável por handler (dedup — guardar 10× não stacka 10 toasts) |
| `CurveSetupPage` — `handleFinish` | `success` contextual («Tudo pronto! A primeira sync arrancou.» vs «Configuração guardada. Sincroniza quando quiseres.») |

- **Implementado:**
  - `client/src/contexts/ToastContext.jsx` — `ToastProvider` + `useToast()` hook + viewport inline (um único ficheiro, ~240 linhas)
  - `client/src/main.jsx` — Provider mounted acima do BrowserRouter (toasts sobrevivem a mudanças de rota)
  - `client/src/components/layout/Icons.jsx` — `CheckCircleIcon`, `ExclamationCircleIcon`, `InformationCircleIcon` para os tons
- **Acessibilidade:**
  - Viewport splits em **duas** listas — `aria-live="polite"` para info/success e `aria-live="assertive"` para errors, para os leitores de ecrã escalarem erros sem interromper constantemente
  - `useReducedMotion()` do `motion/react` reduz animações de entrada/saída para fade de 50 ms quando o user tem a flag ligada
  - Botão de fechar por toast com `aria-label="Fechar notificação"`
- **API:**
  - `toast.success(text, { id?, duration? })`, `toast.error(text, opts)`, `toast.info(text, opts)` — TTL default 4000 ms (5500 ms para errors)
  - `toast.show({ text, tone, id?, duration? })` canonical para casos custom
  - `duration: 0` opt-out de auto-dismiss
  - `id` estável → toast em-loco actualiza em vez de stackar (e.g. clicar "Guardar" 10× mostra **um** toast)
  - Cap de 4 toasts visíveis; o mais antigo cai em overflow
- **Posição:** top-right em `≥ sm`, top-center em mobile (não colide com o topbar do hamburger)
- **Impacto no bundle:** reutiliza `motion/react` já presente; zero novas deps. Total do PR Fase 3.1 + 3.2: +1 kB gzip no client (146 → 147 kB gzip)

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
| ~~IMAP library~~ | ~~`imapflow` vs `node-imap`~~ | **Decidido:** `imapflow` — implementado em `imapReader.js` |
| ~~Scheduler~~ | ~~`node-cron` (in-process) vs `bull` + Redis (queue)~~ | **Decidido:** `node-cron` — implementado em `scheduler.js`; BullMQ reservado para 100+ users |
| ~~Password encryption~~ | ~~`crypto.createCipheriv` (AES-256-GCM)~~ | **Decidido e implementado:** `crypto.js`, chave em `IMAP_ENCRYPTION_KEY` |
