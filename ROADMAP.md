# ROADMAP

Plano de evolução do Curve Sync, organizado por prioridade. Baseado nos TODOs documentados em `docs/expense-tracking.md` e no estado actual do esqueleto.

---

## Fase 1 — Fundação (Prioridade Alta) ✅

### ~~1.1 Pipeline de parsing de emails (cheerio)~~ ✅
Portar a lógica do `curve.py` (BeautifulSoup) para JavaScript/cheerio. Extrair `entity`, `amount`, `date`, `card` a partir do HTML dos emails Curve usando os selectores CSS originais (`td.u-bold`, `td.u-greySmaller.u-padding__top--half`, `td.u-padding__top--half`). Adicionar selectores fallback para resiliência caso o Curve mude o template.

- **Implementado:** `server/src/services/emailParser.js`

### ~~1.2 Leitor IMAP directo~~ ✅
Implementar ligação IMAP directa (substituindo offlineimap) para ler emails da pasta configurada. Usar a flag `UNSEEN` para saber quais emails já foram processados. Marcar como `Seen` apenas após processamento com sucesso. Janela do `SEARCH UNSEEN SINCE` ancorada ao início do ciclo actual (derivado de `sync_cycle_day`, default dia 22) + `max_emails_per_run` (hard cap 500) para evitar first-sync massivo. Ver `docs/EMAIL.md` → «Sync scope».

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

### 2.6.1 Ligar o range de datas do chart `/` ao `/expenses` 🔗

Follow-up da §2.6. O backend aceita `?start=YYYY-MM-DD&end=YYYY-MM-DD` desde o dia em que essa fase aterrou, e o `CycleTrendCard` (§2.8) já navega para `/expenses?start=…&end=…` ao clicar numa barra. **Mas o `ExpensesPage` ignora os query params ao aterrar** — a página vê o URL, fetch em branco, mostra toda a listagem. O click da barra fica mudo.

Esta secção documenta o PR que fecha a ligação. Scope maior do que a §2.10.1 porque toca em estado, URL, autocomplete, empty-state e copy.

#### Contrato de URL

```
/expenses?start=YYYY-MM-DD&end=YYYY-MM-DD&search=…&page=…
```

Regras:

| Regra | Comportamento |
|-------|---------------|
| `start` e `end` opcionais e independentes | Só `start` = «desde X em diante»; só `end` = «até X inclusive»; ambos = range fechado; nenhum = sem filtro |
| Formato | `YYYY-MM-DD` estrito; outros formatos caem silenciosamente (backend via `$dateFromString onError: null`, frontend limpa o query param) |
| Intervalo inválido | `start > end` → o frontend **ignora** os dois params e mostra toast informativo em vez de fazer o round-trip |
| Timezone | UTC em ambos os lados — `start` = `00:00:00.000Z`, `end` = `23:59:59.999Z` (já implementado no backend) |
| Interacção com `search` | Aditivo — um range + um search combinam-se via `AND` |
| Interacção com `page` | Preservado — mudar de página mantém o filtro no URL |
| Preservação em acções | Toggle de exclusão, alterar categoria, batch-move **mantêm** o URL intacto (são writes, não substituem filtros) |

#### Fluxo de dados

```
CycleTrendCard (click numa barra)
    │
    ├─ useNavigate(`/expenses?start=…&end=…`)
    │
    ▼
ExpensesPage (mount / route change)
    │
    ├─ useSearchParams() → { start, end, search, page }
    ├─ validate(start, end) → { clean, errors }
    │      └─ se errors: toast + history.replace sem os params inválidos
    │
    ▼
api.getExpenses({ page, limit, search, start, end, sort: '-date_at' })
    │
    ▼
server/src/routes/expenses.js  [✅ já aceita + filtra]
    │
    ▼
UI renderiza listagem + chip de filtro activo (ver abaixo)
```

#### UI — o que é novo

**A) Chip de filtro activo** — um pill acima da tabela, abaixo do `PageHeader`, quando `start || end` estão presentes:

```
┌──────────────────────────────────────────────────────┐
│  📅  22 Mar → 21 Abr 2026     [N despesas]    [×]    │
└──────────────────────────────────────────────────────┘
```

- Ícone lucide `CalendarRange`
- Texto: `{formatAbsoluteDate(start)} → {formatAbsoluteDate(end)}` (reutilizar `client/src/utils/relativeDate.js`). Se só `start`, `A partir de 22 Mar 2026`. Se só `end`, `Até 21 Abr 2026`.
- Contador `[N despesas]` — o mesmo `total` que vem no `meta`, pt-PT pluralizado
- Botão `×` de limpar — `history.push('/expenses')` sem params (preserva `search` se houver)
- Classe: reutilizar o visual dos banners de undo (`bg-sand-50 border border-sand-200`)

**B) Empty state contextual** — quando o range devolve zero linhas:

```
┌─────────────────────────────────────┐
│                                      │
│        📭                            │
│  Sem despesas entre                  │
│   22 Mar e 21 Abr 2026               │
│                                      │
│  [Ver todas as despesas]             │
└─────────────────────────────────────┘
```

- Reutilizar o `EmptyState` existente com copy específico
- CTA «Ver todas as despesas» limpa o range e recarrega

**C) Integração com o campo de `search`** — mantém-se tal e qual, mas:
- `onSubmit` do search **não** limpa os params `start/end` (os dois coexistem)
- Clicar no `×` do chip de range **não** limpa o `search` (são independentes)

**D) Estado de loading com filtro** — nada muda além do skeleton actual; o `getExpenses` traz `meta.total`, o chip já sabe o número.

#### Edge cases

1. **`start > end`** (user-crafted URL, bug do chart): frontend detecta no parse, mostra toast «Intervalo de datas inválido», chama `setSearchParams` removendo ambos. Listagem carrega sem filtro.
2. **Só uma data**: perfeitamente válido — backend aceita `start` ou `end` isoladamente. Chip rende «A partir de …» ou «Até …».
3. **Datas no futuro**: válidas — devolve listagem vazia se não houver despesas. Sem aviso especial (a natureza do futuro é que está vazio).
4. **Datas no passado distante**: idem.
5. **Refresh da página com filtro activo**: URL é source of truth → re-hydrata o filtro no mount. Zero estado persistido em React state; tudo vem do `useSearchParams`.
6. **Paginação dentro do filtro**: `setSearchParams({ ...current, page: 2 })` preserva `start/end`.
7. **Mudar a `search` com filtro activo**: a submit do search apenas updata `search` no URL; `start/end` sobrevivem.
8. **Deep-link de fora (bookmark, Slack)**: funciona igual ao click da barra — é o mesmo URL.
9. **User sem data alguma no range**: chip mostra `0 despesas`, empty state contextual aparece.
10. **Sync dispara enquanto o filtro está activo**: re-fetch mantém filtro (o orchestrator só escreve, não navega).

#### Accessibility

- Chip tem `role="status"` + `aria-live="polite"` — quando o user muda o range, screen readers anunciam o novo intervalo
- Botão `×` tem `aria-label="Limpar filtro de datas"`
- Empty-state CTA é focável por teclado
- Contraste WCAG AA: `sand-700` sobre `sand-50` → OK

#### Impacto no `ExpensesPage.jsx` (scope real)

Ficheiros tocados:

| Ficheiro | O quê |
|----------|-------|
| `client/src/pages/ExpensesPage.jsx` | `useSearchParams`, validação, forward de `start/end` para `api.getExpenses`, chip de filtro, empty state contextual, eliminação do `useState` para `page/search` (derivar do URL) |
| `client/src/components/common/ExpensesFilterChip.jsx` | **Novo** — componente isolado para o chip, reusável se aparecer outro filtro (card/entity) |
| `client/src/utils/relativeDate.js` | Zero mudanças — `formatAbsoluteDate` já cobre |
| `server/src/routes/expenses.js` | **Zero mudanças** — já validado e já filtra |
| `server/test/expenseFilters.test.js` | Eventualmente, +1 teste end-to-end que exercite o deep-link (manual, por agora) |

**Refactor esperado**: migrar `page`, `search`, `start`, `end` de `useState` para `useSearchParams`. Isto é o core do PR — evitar que o user navegue com back/forward e perca contexto.

#### Follow-ups explicitamente fora de scope

- **Datepicker UI** para seleccionar datas manualmente (`<input type="date">` básico ou lib). Só se houver demand real — a entrada principal é via chart.
- **Presets** («Este ciclo», «Últimos 30 dias», «Este ano»). Útil mas adiciona copy + lógica; separar em follow-up.
- **Filtro por entity / card com URL** — análogo mas independente; a infra que construímos aqui serve de template.
- **Analytics dos cliques** do chart para a listagem. Útil para saber se a feature é usada; requer infra de telemetria.
- **Undo do `×` do chip** (6 s para restaurar o filtro) — provavelmente over-engineering.

#### Implementação por fases

| Fase | Scope | Entrega |
|------|-------|---------|
| **1 — URL-driven state** | Migrar `page/search` para `useSearchParams`; adicionar parsing de `start/end`; forward para a API | Click na barra passa a filtrar, mas sem chip visível |
| **2 — Chip + empty state** | `ExpensesFilterChip.jsx` novo, wire do botão `×`, empty state contextual | UI completa |
| **3 — Validação + toasts** | `start > end`, formatos inválidos → toast informativo, limpar URL | Edge cases cobertos |
| **4 — Polish** | Copy fina, micro-animação de entrada do chip, testes manuais pelos edge cases acima | Done |

Cada fase pode aterrar em commits separados dentro do mesmo PR, ou ser PR por fase se a review quiser dividir.

#### Testes (manual pela feature)

Golden path:
- [ ] Clicar numa barra do chart → `/expenses` aterra já filtrado, chip visível com o range correcto
- [ ] Contador do chip bate com o `total` da meta
- [ ] `×` do chip volta para `/expenses` sem params
- [ ] Paginar dentro do filtro preserva o range
- [ ] Search + range combinam
- [ ] Refresh da página preserva o filtro

Edge cases:
- [ ] `?start=invalid` → filtro é ignorado, URL limpa, listagem normal
- [ ] `?start=2026-04-21&end=2026-03-22` → toast de erro, URL limpa
- [ ] Deep-link de um período vazio → empty state contextual com CTA
- [ ] Toggle de exclusão dentro do filtro → filtro sobrevive
- [ ] Alterar categoria dentro do filtro → filtro sobrevive
- [ ] Mobile: chip não quebra a tabela, continua legível

#### Referências

- ROADMAP §2.6 — contrato backend (já implementado)
- ROADMAP §2.8 — `CycleTrendCard`, onde nasce o click (`client/src/components/dashboard/CycleTrendCard.jsx:350-360`)
- `server/src/routes/expenses.js:170-200` — parsing de `start/end` Mongo-side
- `client/src/utils/relativeDate.js` — `formatAbsoluteDate` para o chip
- `client/src/components/common/EmptyState.jsx` — template do empty state
- `client/src/contexts/ToastContext.jsx` — infra de toasts para validação

---

### ~~2.7 Encriptação de credenciais IMAP~~ ✅
Movido para MU-5 e implementado: AES-256-GCM at rest, decrypt on-the-fly, backwards-compat com plaintext. Ver `server/src/services/crypto.js`.

### ~~2.8 Gráfico evolutivo agregador por ciclo~~ ✅ 📈

> **Implementado.**
>
> Backend:
> - `server/src/services/expenseStats.js :: computeCycleHistory({ userId, cycles })` — agregação multi-ciclo pura (overrides `{ now, config, expenses, exclusions, categories }` para testes hermeticos). Cap [1, 36]. Exclusões da §2.10 filtradas do total, do `top_entity` e do `top_category`, em paridade com o `month_total`. Cada ciclo carrega `delta_absolute`, `delta_pct`, `moving_avg_3` (trailing 3), `top_entity: { name, total }`, `top_category: { name, pct }`, e `in_progress: boolean`. O `trend` global só dispara com ≥ 3 ciclos completos (ignora o in-progress) e colapsa para `null` quando a janela está toda a zero. O `monthly_budget` é calculado como `weekly_budget × 30.4375 / 7` para servir de linha horizontal de referência.
> - `server/src/routes/expenses.js` — `meta.cycle_history` no `GET /api/expenses` (sempre 24 ciclos; o frontend fatia local via toggle para evitar round-trips). Stats + history paralelizados via `Promise.allSettled`, cada ramo cai para `null` sem 500ar a listagem.
> - `server/test/expenseStats.test.js` — +7 testes (delta, cap, exclusões, moving avg, vazio, trend "down", top_category resolvido via override). Paralelamente, todos os testes pré-existentes que chamavam `computeDashboardStats` sem `exclusions: []` ganharam o override (estavam a 500ar contra `CurveExpenseExclusion.find()` num userId string).
>
> Frontend:
> - `client/src/components/dashboard/CycleTrendCard.jsx` — `recharts` `ComposedChart` com `Bar`, `Line` (MA 3 ciclos) e `ReferenceLine` (orçamento). Cor por barra: `emerald-500` (gastou menos), `curve-600` (gastou mais), `sand-400` (primeiro ciclo). Barra do ciclo em curso com pattern hachurado + stroke dashed. Tooltip custom com janela completa, total, delta, nº despesas, top entidade, categoria dominante. Badge contextual de tendência no header (`↓`/`↑`/`→`). Click numa barra → `/expenses?start=<cycle_start>&end=<cycle_end>` (liga na §2.6). Tabela `sr-only` com os mesmos dados para leitores de ecrã; `role="img"` + `aria-label` no wrapper do chart.
> - **Toggle 6m / 12m / 24m** no topo direito. Default 12m. Se o utilizador tiver ≤ 6 ciclos de histórico, snap a 6m e as opções 12m/24m ficam `disabled` com `title="Precisas de N ciclos de histórico"`. O `effectiveSize` recalcula-se quando o volume de dados muda sem obrigar a re-set explícito.
> - Estado vazio (≤ 1 ciclo): ilustração suave + copy «Regressa daqui a um ciclo para veres a tua tendência.»
> - **`React.lazy` + `Suspense`** — o chunk `CycleTrendCard` (recharts + d3) isola-se em 115 kB gzip; o bundle principal mantém-se em 152 kB gzip (vs. 146 antes). Fallback é skeleton `h-80` com `animate-pulse` para evitar CLS enquanto o chunk streameia.
> - `DashboardPage.jsx` — card aterra abaixo de «Despesas recentes», condicionado a `stats?.cycle_history`.
>
> **`prefers-reduced-motion`:** coberto pelo bloco global em `index.css` — todas as animações do recharts (incluindo `isAnimationActive`) caem a `0.01ms !important` quando o utilizador tem a flag ligada.
>
> **Decisões face à spec:**
> - Moving avg **inclui** o ciclo in-progress (smooths sozinho); se se mostrar ruidoso na prática, vira prop `excludeInProgress`.
> - `top_entity` / `top_category` per-ciclo saem como enriquecimento da spec original — dão contexto no tooltip sem obrigar o user a deep-linkar. Custo: mais um `Category.find({ _id: { $in } })` restrito aos ids que apareceram como "top" em algum bucket (lean).
> - `monthly_budget` como linha horizontal tracejada. A spec original falava em `weekly_budget × 4`; subi para `× 30.4375 / 7` (≈ 4,348) porque os ciclos têm 28-31 dias reais.

### 2.8 — nota histórica (spec original)

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

### ~~2.9 Data relativa user-friendly na tabela de despesas recentes~~ ✅ — MVP

> **Implementado.**
> - `client/src/utils/relativeDate.js` — `formatExpenseDate(iso, now?)` + `formatAbsoluteDate(iso)`; sete bandas civil-day-aware (`ontem` é o dia civil anterior em fuso local, não rolling 24 h). `Intl.DateTimeFormat('pt-PT')` com cache do formatter.
> - `DashboardPage.jsx` + `ExpensesPage.jsx` — coluna Data agora renderiza `formatExpenseDate(exp.date)` com `title={formatAbsoluteDate(exp.date)}` na `<td>` para tooltip com a data completa.
> - Sem impacto no backend, no schema, ou no pipeline de sync.

### 2.9 — nota histórica (spec original)

Substituir a string crua de `Expense.date` na coluna **Data** da tabela «Despesas recentes» do Dashboard (e, por extensão, da tabela de `/expenses`) por uma formulação relativa em português, mais legível de relance. A ideia é que uma despesa de hoje se leia como «há 3 min» ou «há 2 h» e uma dos últimos dias como «ontem», «anteontem» ou «há N dias» (até um máximo de **5** dias), caindo para a data absoluta (ex. `17 Abr 2026`) a partir daí.

**Estado actual:**

- O Dashboard já tem um formatter relativo (`formatRelativePt`) em `client/src/pages/DashboardPage.jsx:22` — mas **só o usa para o StatCard «Último sync»**. A coluna Data da tabela renderiza `exp.date` cru (linha `<td className="px-5 py-3 text-sand-500">{exp.date}</td>`)
- `/expenses` também renderiza `exp.date` cru
- `Expense.date` é armazenado como string (vem do parser cheerio — ver `emailParser.js` e o padrão de `parseExpenseDate` em `expenseStats.js`), portanto é necessário passar por `Date.parse` antes de comparar

**Requisitos funcionais:**

| Diferença face a `now` | Texto renderizado |
|------------------------|-------------------|
| `< 60 s` | `há segundos` |
| `< 60 min` | `há N min` |
| `< 24 h` | `há N h` |
| 1 dia (mesmo dia civil anterior) | `ontem` |
| 2 dias | `anteontem` |
| 3–5 dias | `há N dias` |
| `> 5 dias` ou data no futuro | fallback para a data absoluta `DD MMM YYYY` (pt-PT, `Intl.DateTimeFormat`) |

- A decisão **dia civil vs. 24 h rolling** importa: «ontem» deve ser o dia civil anterior ao de hoje no fuso local, não «entre 24 e 48 h atrás». Uma despesa feita ontem às 23:00 e vista hoje às 08:00 deve ler «ontem», não «há 9 h»
- O `title` attribute da `<td>` passa a carregar a data absoluta completa (para o utilizador passar o cursor e ver o valor exacto)
- Datas não parseáveis caem silenciosamente para o texto original — nunca quebrar a linha

**Estrutura de implementação:**

1. **Frontend — novo helper partilhado**
   - `client/src/utils/relativeDate.js` — `formatExpenseDate(iso, now = Date.now())` puro, testável; cobre as 7 bandas acima + fallback absoluto
   - `DashboardPage.jsx` — substituir `{exp.date}` por `{formatExpenseDate(exp.date)}` e mover `formatRelativePt` (StatCard do "Último sync") para usar a banda curta do mesmo helper para consistência
   - `ExpensesPage.jsx` — idem na coluna Data
   - Adicionar `title={formatAbsoluteDate(exp.date)}` à `<td>` em ambos os sítios

2. **Testes**
   - `client/src/utils/__tests__/relativeDate.test.js` (ou homólogo server-side se optarmos por fazer o cálculo no backend — ver nota abaixo) com casos:
     - `now - 30 s` → `há segundos`
     - `now - 5 min` → `há 5 min`
     - `now - 3 h` → `há 3 h`
     - Ontem 23:00 visto hoje 08:00 → `ontem` (não `há 9 h`)
     - Anteontem → `anteontem`
     - `now - 4 dias` → `há 4 dias`
     - `now - 6 dias` → fallback absoluto
     - Data inválida / vazia → string original devolvida sem crash
     - Fuso: deve respeitar timezone local (o server é UTC, o cliente é pt-PT)

3. **Decisão aberta — client-side vs server-side**
   - **Opção A (preferida):** cálculo no cliente. Prós: timezone local nativo, re-renderiza ao navegar entre páginas sem stale, zero bytes na wire. Contras: se a aba ficar aberta 5 horas, `há 2 min` fica parada até um re-render (mitigável com um `setInterval(60_000)` no dashboard)
   - **Opção B:** calcular no backend em `parseExpenseDate` e serializar. Prós: uma única fonte de verdade, testes em Node. Contras: perde timezone do utilizador (o backend é UTC), envelhece assim que o payload é servido
   - A opção A ganha pela UX e pela ausência de mudança no contrato da API

**Notas de design:**

- Máximo de 5 dias não é arbitrário — acima disso o texto relativo perde utilidade («há 17 dias» diz menos do que `30 Mar 2026`) e a data absoluta é mais rápida de ler
- A data absoluta usa `Intl.DateTimeFormat('pt-PT', { day: '2-digit', month: 'short', year: 'numeric' })`, consistente com o resto da app
- Não mexer em `Expense.date` no schema — o campo continua string, a formatação é apenas de apresentação

**Dependências:** Nenhuma. É puramente visual; zero impacto no backend, no schema, ou no pipeline de sync.

**Referências:**
- `client/src/pages/DashboardPage.jsx:22` — `formatRelativePt` actual (apenas «Último sync»)
- `server/src/services/expenseStats.js` — `parseExpenseDate` defensivo (mesma estratégia de parsing se optarmos por Opção B)
- `docs/UIX_DESIGN.md` — tom/voz pt-PT

---

### ~~2.10 Excluir despesa do ciclo / Savings Score~~ ✅ — MVP

> **Implementado.**
>
> Backend:
> - `server/src/models/CurveExpenseExclusion.js` — nova colecção Curve-Sync-owned (`curve_expense_exclusions`), mesmo padrão do `CategoryOverride`. Unique index em `(user_id, expense_id)` torna o POST idempotente. Schema de `expenses` intocado (respeita CLAUDE.md → MongoDB Collection Access Rules).
> - `server/src/routes/expenses.js` — `POST /api/expenses/exclusions` + `DELETE /api/expenses/exclusions`, body `{ expense_ids: [...] }`, cap 500. Validação de ownership antes de escrever (cross-user silently no-op). Respostas `{ affected, skipped }`.
> - `GET /api/expenses` — cada row ganha `excluded: boolean`; query param `?exclude_filter=excluded|included|all` (default `all`) para filtrar a vista.
> - `server/src/services/expenseStats.js :: computeDashboardStats` — exclusões carregadas em paralelo e filtradas do `month_total` **e** do `weekly_expenses`, portanto o `savings_score` também desce automaticamente. Override de testes aceita `{ exclusions }` no mesmo shape.
> - `server/src/models/CurveLog.js` — dois novos valores de `action`: `expense_excluded_from_cycle`, `expense_included_in_cycle`. Single-row carrega `expense_id + entity`; bulk carrega só `detail = "count=<N>"`.
>
> Frontend:
> - `client/src/services/api.js` — `excludeExpenses(ids)`, `includeExpenses(ids)`.
> - `ExpensesPage.jsx` — botão «Excluir do ciclo / Incluir no ciclo» no action bar (label flipa conforme `selectionAllExcluded`). Optimistic update, banner de undo inline (6 s, mesmo padrão da §2.5), row tinting `bg-sand-50 opacity-60` + badge `excluída` na coluna Data.
> - `DashboardPage.jsx` — row tinting e badge espelham o visual da `/expenses` (sem toggle UI — exclusão só se controla a partir de `/expenses`).
>
> Scope cut vs spec original:
> - Undo é one-at-a-time (não per-expense como o banner de categorias) porque um «excluir 10» é semanticamente uma acção única que o user vai querer anular como um todo — menos clutter na UI.
> - Testes server-side não foram adicionados neste PR (follow-up: estender `expenseStats.test.js` + novo `expenseExclusions.test.js`).

### 2.10 — nota histórica (spec original)

Permitir ao utilizador marcar uma despesa como **excluída do cálculo do ciclo actual e do Savings Score**, sem a apagar (DELETE em `expenses` continua proibido — Embers é owner). O caso de uso canónico: uma despesa anormal (reembolso pendente, pagamento de grupo que outra pessoa vai devolver, erro de categorização que obriga a duplicado) que distorce o «Despesas este mês» ou o Savings Score sem razão estrutural.

**Requisitos funcionais:**

- Em `/expenses`, o action bar actual «*N* despesa(s) seleccionada(s) · Limpar · Mover para…» passa a ter uma terceira acção: **«Excluir do ciclo»** (toggle — se toda a selecção já está excluída, o botão passa a «**Incluir no ciclo**»)
- Despesas excluídas aparecem **com cor de fundo distinta** na tabela (ex. `bg-sand-50` + texto `text-sand-400` + badge discreto `excluída` na coluna Categoria ou Data) para o utilizador perceber de relance que não contam para os totais
- No Dashboard, as mesmas despesas aparecem com a mesma estilização na «Despesas recentes»
- Os `StatCard` do Dashboard (**Despesas este mês** e **Savings Score**) **ignoram** despesas excluídas no ciclo actual — tanto `month_total` como o `weekly_expenses` da fórmula do score
- A coluna «Sem categoria» continua a contar o que o utilizador vê; excluir não re-categoriza
- Undo curto (mesmo padrão da §2.5 / docs/Categories.md §12 — 6 s para anular a última exclusão/inclusão via banner)
- Auditoria: cada toggle escreve em `curve_logs` com novas acções `expense_excluded_from_cycle` e `expense_included_in_cycle` (ver `docs/CURVE_LOGS.md` §4 para o contrato e `docs/Categories.md` §13.2 para o padrão de enumeração)

**Constraint crítico — não se pode alterar o schema de `Expense`:**

Por `CLAUDE.md` → MongoDB Collection Access Rules, a coleção `expenses` só aceita UPDATE ao campo `category_id`:

> **`expenses`** — READ + INSERT + UPDATE of **`category_id` only**. All other fields [...] remain INSERT-only. DELETE is still forbidden — Embers owns the destroy path.

Logo, **não se pode adicionar** um campo `excluded_from_cycle` a `Expense`. A solução segue o mesmo padrão do `CategoryOverride` (§2 do `docs/Categories.md`): nova colecção **owned exclusivamente pela Curve Sync**, invisível ao Embers.

**Modelo novo — `CurveExpenseExclusion`:**

```js
// server/src/models/CurveExpenseExclusion.js
{
  user_id:    ObjectId,  // required, indexed
  expense_id: ObjectId,  // required — ref Expense
  created_at: Date,      // when it was excluded
  note:       String,    // optional short reason typed by the user
}
// Unique index: { user_id: 1, expense_id: 1 }
// Collection name (explicit): 'curve_expense_exclusions'
// Access control: always scoped by `user_id: req.userId`
```

**Estrutura de implementação:**

1. **Backend — modelo + routes**
   - `server/src/models/CurveExpenseExclusion.js` — schema acima, `strict: true`, `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }`
   - `server/src/routes/expenseExclusions.js` (ou estender `routes/expenses.js`):
     - `POST /api/expenses/exclusions` — body `{ expense_ids: [...] }`; upsert por par `(user_id, expense_id)`; devolve contagem criada/existente
     - `DELETE /api/expenses/exclusions` — body `{ expense_ids: [...] }`; remove exclusões para os ids
     - Single-row também válido (`POST` com um id), para o banner undo
   - Todas as handlers filtram por `req.userId` primeiro (exactamente como `CategoryOverride`)

2. **Backend — integração com stats**
   - `expenseStats.js :: computeDashboardStats` passa a carregar `CurveExpenseExclusion.find({ user_id }).select('expense_id').lean()` e filtra o agregado:
     ```js
     const excluded = new Set(exclusions.map(e => String(e.expense_id)));
     const effective = expenses.filter(e => !excluded.has(String(e._id)));
     ```
   - O mesmo filtro aplica-se tanto a `month_total` como a `weekly_expenses` (que alimenta `computeSavingsScore`). Logs de auditoria NÃO são recalculados — a exclusão é de *apresentação*, não de *existência* da despesa
   - `computeCycleHistory` (§2.8, quando aterrar) lê o mesmo conjunto e aplica o mesmo filtro por ciclo para que o gráfico seja coerente

3. **Backend — listagem de despesas**
   - `GET /api/expenses` junta a cada row o booleano `excluded: true|false` via `$lookup` ou join em memória (preferir in-memory para escala actual — 1 query extra por página, pequena)
   - Query param opcional `?exclude_filter=excluded|included|all` (default `all`) para o utilizador filtrar a vista

4. **Frontend — action bar em `/expenses`**
   - `ExpensesPage.jsx` — adicionar botão «Excluir do ciclo» no bloco `{selectedIds.size > 0 && (...)}` (linha ~492). Texto alterna para «Incluir no ciclo» quando `selectedIds.every(id => row.excluded === true)`
   - Handler chama `POST/DELETE /api/expenses/exclusions`, actualiza rows optimisticamente, e empurra um undo banner (mesma infra do `categoryEdits` — ver `CategoryEditUndoBanner`)

5. **Frontend — estilização de rows excluídas**
   - `<tr>` ganha `className` condicional: `data-excluded={exp.excluded}` + uma classe tailwind `opacity-60 bg-sand-50` quando excluído
   - Badge `excluída` pequeno na coluna Data (reaproveitar `.badge bg-sand-100 text-sand-400`)
   - Mesma estilização em `DashboardPage.jsx :: Despesas recentes`
   - `title` na row explica «Esta despesa está excluída do cálculo do ciclo e do Savings Score»

6. **Auditoria (`curve_logs`)**
   - 2 novas acções: `expense_excluded_from_cycle`, `expense_included_in_cycle`
   - Payload inclui `expense_id`, `entity`, `amount`, `count` (para toggles em massa). Ver contrato em `docs/CURVE_LOGS.md` §4
   - Lista `/curve/logs` ganha labels pt-PT para os novos tipos (mesmo padrão das 13 acções de categorias)

**Testes:**

- `server/test/expenseExclusions.test.js` — CRUD de exclusões (scoped por `user_id`, não pode ver exclusões de outros), toggle idempotente
- `server/test/expenseStats.test.js` — estender os casos existentes: `computeDashboardStats` com 3 expenses, 1 excluída → `month_total` e `weekly_expenses` ignoram-na; Savings Score sobe em conformidade
- `client` — smoke test do botão (se houver setup de testes frontend) ou teste manual documentado

**Notas de design:**

- **Porquê toggle em vez de soft-delete?** «Excluir» sugere acção destrutiva; a ideia é apenas «não contar para este mês». O verbo «Excluir do ciclo / Incluir no ciclo» é explícito e reversível
- **Scope da exclusão é global, não por-ciclo**: uma vez excluída, a despesa não conta para nenhum cálculo (ciclo actual, histórico, score). Permitir exclusão *só no ciclo X* seria sobre-engenharia — quase ninguém volta a ver um ciclo passado
- **Não aparece em `/curve/logs?tab=uncategorised`**: a exclusão é ortogonal à categorização
- **Por-user, sempre**: mesmo admin não vê nem mexe em exclusões de outros (mesmo padrão de `CurveCategoryOverride`)

**Dependências:**
- Requer **2.5** (stats no Dashboard) — estende `computeDashboardStats`
- Beneficia de **2.6** (filtros `/expenses`) — o `?exclude_filter=` encaixa nos query params existentes
- Não depende de **2.8** (gráfico por ciclo), mas o gráfico deve aplicar o mesmo filtro quando aterrar

**Referências:**
- `CLAUDE.md` → «MongoDB Collection Access Rules» (constraint de não-mexer no schema de `expenses`)
- `server/src/models/CategoryOverride.js` — template para uma colecção Curve-Sync-only
- `server/src/services/expenseStats.js` — `computeDashboardStats` e `computeSavingsScore`
- `client/src/pages/ExpensesPage.jsx:492` — bloco do action bar da selecção
- `docs/Categories.md` §12 — padrão do undo banner optimista (reutilizar)
- `docs/CURVE_LOGS.md` §4 — contrato do `curve_logs` para as 2 novas acções

---

### 2.10.1 Atalho «Remover do Ciclo» no popover «Alterar categoria»

Follow-up do §2.10. O toggle de exclusão existe hoje **apenas** no action bar multi-select de `/expenses`; o caso de uso mais comum («abri esta despesa para mudar a categoria, mas afinal o que quero é não a contar no ciclo») exige sair do popover, fechar a linha, seleccionar, e clicar noutro botão. Atalho: um mini botão vermelho no header do `CategoryPickerPopover`, à esquerda do `×`, que chama a infra §2.10 para a expense em foco e fecha o popover com o mesmo banner de undo.

#### TODO 1 — Investigação: como é que o Embers apaga uma despesa?

**Objectivo:** decidir se imitamos o `destroy` do Embers ou se reaproveitamos a infra de exclusão da §2.10.

**Achados** (código fonte em `docs/embers-reference/`):

- `controllers/expenses_controller.rb:64-75` — `def destroy` chama `expense.destroy`, **hard delete** Mongoid. A despesa desaparece da colecção. Sem `Mongoid::Paranoia`, sem campo `deleted_at`.
- `models/expense.rb` — zero suporte para soft-delete. Única forma de «recuperar» é reprocessar o email original (que tem a flag `\Seen` por causa do `imapReader`, mas continua no arquivo).
- `frontend/services/expense.js:39-45` — existe `destroy(id)` **e** `undestroy(id)`, mas o controller não implementa `undestroy` — o `undestroy` é só usado por Organizations. **Na prática o delete de expense no Embers é irreversível.**
- A escolha do Embers faz sentido no contexto dele (single-user, feito manualmente, terminal-first). Não faz sentido no Curve Sync: o schema partilhado proíbe DELETE em `expenses` (CLAUDE.md → «MongoDB Collection Access Rules»: «DELETE is still forbidden — Embers owns the destroy path»), e mesmo que não proibisse, apagar a row fazia o próximo sync re-ingerir a mesma despesa porque o email continua no arquivo (`\Seen` não impede o `imap_since` de a devolver na primeira sync após uma reset do `last_sync_at`).

**Opções em cima da mesa:**

| # | Abordagem | Prós | Contras |
|---|-----------|------|---------|
| A | Replicar Embers: `DELETE /api/expenses/:id` com hard delete | Familiar | **Proibido por CLAUDE.md**; irreversível; quebra dedup (digest fica órfão, re-ingestão garantida na próxima sync) |
| B | Soft-delete via nova flag em `Expense` (ex. `deleted_at`) | Reversível | **Proibido** — altera schema de colecção partilhada com Embers |
| C | Mover a despesa para uma categoria «Excluída» | Reutiliza o único UPDATE permitido | Polui o catálogo de categorias; perde a categoria original (impossível reverter exactamente); tem que ser filtrada manualmente em todos os agregados |
| D | **Reaproveitar `CurveExpenseExclusion` (§2.10)** | **Infra completa já existe** — modelo, rotas, filtros em stats, auditoria, banner de undo; respeita access rules; zero schema change; reversível; o email fica `\Seen` mas a despesa também pode ser recuperada via «Incluir no ciclo» (o row volta a contar) | Nenhum — é literalmente a semântica que o utilizador pediu |

**Recomendação:** Opção D. A nota «uma expense pode sempre ser recuperada pois temos o arquivo de email com todos os receipts» é verdadeira mas irrelevante — não precisamos do arquivo porque a despesa nunca é apagada, só é marcada como «não contar para o ciclo», e o toggle é reversível em 1 clique.

**Saída deste TODO:** esta secção do ROADMAP + o commit que a introduz. Nenhum código novo; a decisão é «usar §2.10».

#### TODO 2 — UI: mini botão «Remover do Ciclo» no header do `CategoryPickerPopover`

**Scope:** um novo affordance dentro do popover que já existe. Nada de rotas novas, nada de modelos novos, nada de novas acções de audit — tudo reaproveita §2.10.

**Acceptance criteria:**

1. **Popover** (`client/src/components/common/CategoryPickerPopover.jsx`):
   - Nova prop opcional `onRemoveFromCycle?: () => void`.
   - Nova prop opcional `excluded?: boolean` (espelho do `expense.excluded` que o parent já tem).
   - Renderizar um `<button>` no header, à **esquerda** do `×` de fechar, apenas quando:
     - `onRemoveFromCycle` é truthy,
     - modo single (`context?.kind !== 'bulk'`),
     - a expense **não** está já excluída (`excluded !== true`).
   - Ícone: `CalendarOff` (ou `CalendarX`) do lucide-react, `h-4 w-4`, tom curve-red — ex. `text-curve-500 hover:bg-curve-50 hover:text-curve-700`. Deliberadamente diferente do cinzento do `×` para não se confundir com «fechar».
   - `title` / `aria-label`: «Remover do ciclo — não conta para Savings Score (reversível)». `title` nativo já chega — não vale a pena montar um Tooltip component só para isto.
   - `disabled={saving}` — desactiva durante um PUT de categoria in-flight.

2. **Consumidores** (3 páginas):
   - **`ExpensesPage.jsx`** — o parent passa `onRemoveFromCycle={() => handleRemoveFromCycleSingle(exp)}` + `excluded={exp.excluded}`. O handler faz:
     1. Optimistic: `exp.excluded = true` na tabela + fecha o popover (`setPickerExpenseId(null)`).
     2. Chama `api.excludeExpenses([exp._id])`.
     3. Regista no `exclusionUndo` existente (mesmo shape que o bulk: `{ ids: [exp._id], direction: 'excluded', affected: 1, skipped: 0, text: 'Despesa <entity> excluída do ciclo.' }`) e agenda o auto-dismiss de 6 s via `scheduleExclusionDismiss`.
     4. Em erro, rollback do optimistic update + erro inline.
   - **`DashboardPage.jsx`** — exactamente o mesmo handler, adaptado ao estado local (o dashboard hoje tem row tinting mas não tem banner de undo — migrar o `exclusionUndo` + `CategoryEditUndoBanner`-like banner para cá, ou extrair o banner para `client/src/components/common/ExclusionUndoBanner.jsx` partilhado e importá-lo nas duas páginas). Sub-decisão: **extrair o banner** — 5 min de refactor, elimina duplicação agora e quando a §2.10 ganhar mais consumidores.
   - **`CurveLogsPage.jsx`** — mesmo tratamento. Este popover é aberto a partir dos pills na timeline de logs; exclusão single-row a partir daqui é legítima e útil.

3. **Undo:** o banner existente já tem o comportamento correcto (6 s, botão «Anular», chama o inverso). Nada a mudar — o parent só precisa de empurrar um novo entry.

4. **Auditoria:** `POST /api/expenses/exclusions` já escreve `expense_excluded_from_cycle` com `expense_id + entity` (single-row). Inverso no `DELETE` escreve `expense_included_in_cycle`. **Zero enum changes.**

5. **Não fazemos** nesta secção:
   - Não mudar categoria ao mesmo tempo — a acção é ortogonal. Se o user quer mudar categoria E excluir, são dois cliques (um no tile, outro no botão). Misturar os dois numa única API call complica o rollback.
   - Não adicionar o botão em modo bulk — no action bar de `/expenses` já existe «Excluir do ciclo» multi-select. Duplicá-lo dentro do popover bulk seria redundante.
   - Não esconder o botão quando o user está a editar a categoria via teclado (o `disabled={saving}` já chega).

**Ficheiros tocados (estimativa):**
- `client/src/components/common/CategoryPickerPopover.jsx` — novas props + botão.
- `client/src/components/common/ExclusionUndoBanner.jsx` — **novo** (extrair do `ExpensesPage.jsx`).
- `client/src/pages/ExpensesPage.jsx` — importar banner extraído, adicionar handler single-row, passar props ao popover.
- `client/src/pages/DashboardPage.jsx` — idem; herda `exclusionUndo` state + banner.
- `client/src/pages/CurveLogsPage.jsx` — idem.

**Testes:** manual — abrir o popover, clicar no novo botão, verificar que (a) o row tinta + ganha o badge «excluída», (b) o banner aparece com «Anular», (c) clicar «Anular» dentro de 6 s reverte, (d) esperar 6 s faz dismiss silencioso, (e) o Savings Score no dashboard reflecte a exclusão sem reload.

**Referências:**
- §2.10 acima — toda a infra backend.
- `client/src/pages/ExpensesPage.jsx:441-532` — `exclusionUndo` state, timer, `handleExclusionToggle`, `handleExclusionUndo` — template exacto para o novo handler single-row.
- `client/src/components/common/CategoryPickerPopover.jsx:175-201` — header do popover onde o botão entra.

---

### ~~2.11 🐛 Dashboard stale após «Sincronizar agora» + tween consistente nos KPIs~~ ✅ — MVP

> **Implementado.** Ver commits abaixo. Resumo do que aterrou:
>
> - `DashboardPage.jsx` — seis fetches consolidados em `loadDashboard()`; chamado no mount e no `finally` de `handleSync` em substituição dos três fetches soltos. Inclui `getExpenses` — que é o que alimenta `stats.month_total` + `stats.savings_score` + `recentExpenses` e, antes, ficava stale até reload
> - `client/src/components/common/AnimatedKPI.jsx` — novo componente partilhado (variantes `default` para o dashboard e `compact` para o KPI strip de `/categories`). Os três cards numéricos do dashboard (Despesas este mês, Savings Score, Sem categoria) passam a usá-lo; o StatCard «Último sync» mantém-se (valor relativo em texto, não numérico)
> - `hooks/useCountUp.js` — tween agora parte de `previousValue` em updates (via ref), só parte de 0 no primeiro paint. Um score a subir de 8.1 → 8.3 já não regride visualmente a 0 antes de climbar
> - **Savings Score = 10** ganha o efeito subtil `kpi-perfect` (`index.css`): shimmer horizontal clipado ao número em gradiente `curve-700 → amber-400 → curve-700`, breathing scale 1 ↔ 1.03 em 2.8 s, halo de `drop-shadow` em `amber-300/55`. Só activa depois do tween aterrar (`Math.abs(tweened - 10) < 0.05`) — senão o efeito piscaria ao atravessar 10.0 durante a subida. Os três layers respeitam `prefers-reduced-motion: reduce` via o bloco global em `index.css`
> - `CategoriesPage.jsx` — migrada para o `AnimatedKPI` partilhado (`variant="compact"`); zero regressão visual no KPI strip

### 2.11 — nota histórica 🐛 (spec original)

**Bug.** Depois de clicar «Sincronizar agora» no Dashboard e o sync importar despesas novas com sucesso, os `StatCard` de **«Despesas este mês»** e **«Savings Score»** continuam a mostrar os valores antigos. A tabela «Despesas recentes» também fica stale. Só o card «Sem categoria» e «Último sync» actualizam, porque são os únicos que `handleSync` re-fetcha. O utilizador tem de recarregar a página para ver o resultado real da sincronização — o que contraria o próprio propósito do botão.

**Root cause.** `DashboardPage.jsx :: handleSync` (linha ~317) faz, no `finally`:

```js
await refreshStatuses();                   // sync_status + oauth_status
api.getUncategorisedStats().then(...)      // uncategorised count
```

Mas **nunca** re-invoca `api.getExpenses({ limit: 5, sort: '-date' })`, que é o endpoint que alimenta:

- `recentExpenses` (tabela inteira)
- `stats` (do `meta`): `month_total`, `savings_score`, `weekly_savings`, `weekly_budget`, `emails_processed`

O `useEffect` de mount só corre uma vez, portanto tudo o que depende de `stats` fica congelado no valor inicial.

**Fix de dados:**

- Extrair a fetch inicial do `useEffect` para um helper `loadDashboard()` (paralelo, `Promise.allSettled`)
- Chamá-lo também no `finally` de `handleSync` em vez do bloco actual de 3 fetches dispersos
- O helper devolve quatro coisas em paralelo: `getExpenses({ limit: 5 })`, `getSyncStatus`, `getOAuthStatus`, `getUncategorisedStats` — todos com fallback silencioso (fetch que falhe não bloqueia o resto)

**Fix de UX — tween estilo slot machine em todos os KPIs numéricos:**

Relacionado mas não dependente: quando os valores **mudam** (post-sync, ou quando o utilizador re-categoriza uma despesa e o Savings Score se mexe), os números devem **re-animar** do valor anterior até ao novo valor, igual ao que já acontece em `/categories` — não um swap instantâneo. Hoje:

| Card | Estado actual | Deve |
|------|---------------|------|
| Despesas este mês | `EUR.format(stats.month_total)` directo | tween €prev → €next |
| Savings Score | `stats.savings_score.toFixed(1)` directo | tween 0.0 → 8.1 |
| Sem categoria | já usa `useCountUp(uncategorisedCount ?? 0)` | ✅ ok |
| Último sync | `formatRelativePt(...)` | N/A (não é numérico) |
| `emails_processed` (sub-label) | `.toLocaleString('pt-PT')` directo | tween do contador |

O padrão já existe e está provado em `client/src/pages/CategoriesPage.jsx:300` — o componente `AnimatedKPI` (`const tweened = useCountUp(value, 800)` + formatador à volta). **Reaproveitar — não recriar.**

**Estrutura de implementação:**

1. **Componente partilhado** — mover `AnimatedKPI` de `CategoriesPage.jsx` para `client/src/components/common/AnimatedKPI.jsx`:
   ```jsx
   export function AnimatedKPI({ label, value, format, sub, accent, title }) {
     const tweened = useCountUp(value ?? 0, 800);
     return (
       <StatCard
         label={label}
         value={value == null ? '—' : format(tweened)}
         sub={sub}
         accent={accent}
         title={title}
       />
     );
   }
   ```
   - Notar: `value == null` → `—` (não mostra `0` durante o primeiro paint se o fetch ainda não resolveu)
   - Reusa o `StatCard` existente para manter o visual consistente

2. **Dashboard — adoptar `AnimatedKPI` nos três cards numéricos:**
   ```jsx
   <AnimatedKPI
     label="Despesas este mês"
     value={stats?.month_total}
     format={(v) => EUR.format(v)}
     sub={stats?.cycle ? `${stats.cycle.start} → ${stats.cycle.end}` : undefined}
   />
   <AnimatedKPI
     label="Savings Score"
     value={stats?.savings_score}
     format={(v) => v.toFixed(1)}
     sub={...}
     title="..."
     accent
   />
   ```
   - Para «Sem categoria» já existe uma versão manual do `useCountUp`; substituir pela nova abstracção para cortar o código duplicado

3. **`loadDashboard()` helper** — consolida todas as fetches num único ponto de entrada; chamado no mount e em `handleSync.finally`. Cada fetch individual continua a falhar silenciosamente para preservar o comportamento actual de «a dashboard nunca é hostage de um endpoint que esteja em baixo».

4. **`useCountUp` — pequeno ajuste** (opcional, afina a UX):
   - Hoje o hook anima sempre de `0 → value`. Isso é correcto no primeiro paint, mas em updates (post-sync) fica jumpy: um score que passa de `8.1` para `8.3` recua visivelmente para `0` e sobe
   - Alterar o hook para animar de **`previousValue` → `value`** em transições subsequentes, mantendo `0` só como valor inicial do primeiro paint. O spec em `/categories` também beneficia — hoje disfarça-se porque mudar de categoria reseta visualmente os quatro cartões, mas a animação ainda assim «vem do 0»
   - Implementação: guardar o `value` anterior num `ref`, usar `ref.current` como `from` no `tick`, actualizar no fim do rAF
   - `prefers-reduced-motion: reduce` continua a cortar a animação inteira

**Testes:**

- `client/src/hooks/__tests__/useCountUp.test.js` — novo caso para previous-value animation (update de 5 → 8 não passa por 0)
- Smoke manual no dashboard: clicar «Sincronizar agora» → confirmar que os quatro cards actualizam sem reload e que os números tween-am do valor anterior para o novo

**Scope cut consciente:**

- Não estender o tween à tabela «Despesas recentes» (só aos KPIs). A tabela já tem `animate-slide-in-right`-style delay por linha (`style={{ animationDelay: ... }}`) que dá a sensação de refresh — misturar com tween numérico fica barulhento
- Não mexer nos StatCards das outras páginas (`/curve/config`, `/curve/logs`); cada uma pode migrar para `AnimatedKPI` em PRs separados se se mostrar útil

**Dependências:** Nenhuma. É um bug fix frontend puro + reuso do hook `useCountUp` já existente.

**Referências:**
- `client/src/pages/DashboardPage.jsx:317` — `handleSync` actual (onde falta o refetch de `getExpenses`)
- `client/src/pages/DashboardPage.jsx:131` — `useEffect` de mount (a extrair para `loadDashboard`)
- `client/src/pages/CategoriesPage.jsx:300` — `AnimatedKPI` existente (a promover a partilhado)
- `client/src/hooks/useCountUp.js` — hook a estender (0→value vira prev→value em updates)
- `client/src/components/common/StatCard.jsx` — componente base inalterado

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

### 3.9 Script de deploy para o servidor de produção (Ubuntu 16) 🚀

Automatizar o deploy em prod com um script único (`scripts/deploy-prod.sh` ou equivalente) que cobre o fluxo actual manual e as suas armadilhas.

**Motivação imediata:** a migração `date_at` da Opção C expôs a dependência de sequência entre código e dados — step 5 (flip do sort default) **tem de** aterrar em prod depois do backfill, senão os utilizadores vêem degradação visível. Hoje a sequência é runbook manual no `README.md` § «Migrações one-shot». Um script que conheça pré-deploys desta natureza evita que a memória operacional se perca entre releases.

**Contexto:** o servidor de produção corre **Ubuntu 16.04 (Xenial)** — package manager antigo, systemd disponível, node/npm instalados à mão. O script não pode assumir ferramentas modernas (ex. `npm ci --omit=dev` funciona; `nvm use --lts` pode não existir).

**Requisitos funcionais:**

| Fase | O que o script faz |
|------|---------------------|
| **1. Pré-voo** | Imprime banner com (a) diff de commits desde o último deploy, (b) **avisos prévios conhecidos** sobre migrações de dados e o _porquê_ (ex. «este release muda o sort de `-date` para `-date_at`; o backfill TEM de correr antes, ver commit XYZ»), (c) estado actual do servidor (disco, memória, processos Curve Sync, uptime do MongoDB) |
| **2. Gate** | Pede confirmação explícita `CONFIRM=yes` ou flag `--yes`. Sem isso, sai com o plano impresso |
| **3. Pull + build** | `git fetch` + `git checkout` do commit alvo, `npm ci` no client e server, `npm run build` (client), `systemctl stop curve-sync` |
| **4. Migrações** | Detecta no diff de commits se há scripts em `server/scripts/` com prefixo `migrate-*` OU se o release inclui `docs/DEPLOY_NOTES.md` com bloco `## migration:` — corre esses primeiro. `analyze-expense-dates.js --write --yes` é o primeiro caso concreto |
| **5. Start** | `systemctl start curve-sync` + health-check (`curl` a `/api/health`) |
| **6. Rollback hook** | Se health-check falha, automaticamente volta ao commit anterior e reinicia |

**Avisos prévios canónicos conhecidos** (a consolidar num ficheiro tipo `docs/DEPLOY_NOTES.md`):

- **Opção C `date_at`** — «Antes deste release, os sorts do dashboard e /expenses passam de `-date` (lex sobre string) para `-date_at` (Date tipada). O backfill em `server/scripts/analyze-expense-dates.js` tem de correr PRIMEIRO, senão rows sem `date_at` vão aparecer no fundo da lista até o backfill correr. Não é data loss — é degradação visível. Ver README §Migrações one-shot.»
- Futuros: sempre que um release mude a interpretação de um campo existente no MongoDB, adicionar aqui a nota com o _porquê_ (não só o que).

**Estrutura proposta:**

```
scripts/
├── deploy-prod.sh              # entry point
├── deploy-lib/
│   ├── preflight.sh            # banner + avisos + estado
│   ├── gate.sh                 # confirmação interactiva
│   ├── pull-build.sh           # git + npm ci + build
│   ├── migrations.sh           # detect + run pending migrations
│   ├── restart.sh              # systemctl + health check
│   └── rollback.sh             # emergency revert
docs/
└── DEPLOY_NOTES.md             # migration banners, updated per release
```

**Scope cut consciente para o MVP deste script:**

- Sem blue/green ou zero-downtime — um `systemctl stop` + `start` é aceitável para single-user prod
- Sem GitHub Actions / CI wiring — corre-se à mão no servidor inicialmente; integração em pipeline é fase 2
- Sem notificações (Slack, email) em falha — o prompt interactivo basta; um `set -euo pipefail` rigoroso trata o resto

**Dependências:** Nenhuma de código. Depende de acesso SSH + systemd unit já configurado no servidor (já existe).

**Referências:**
- `README.md` § Migrações one-shot (contém o runbook manual actual da Opção C)
- `server/scripts/analyze-expense-dates.js` (primeira migração que o script precisa de saber correr)
- `scripts/setup-pi.sh` + `scripts/check-services.sh` (padrão bash existente no repo, reaproveitar estilo)

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
