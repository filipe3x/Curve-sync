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

### 1.5 Sincronização automática (node-cron)
Activar o scheduler com `node-cron` para executar o sync periodicamente conforme o intervalo definido em `curve_configs.sync_interval_minutes`. Incluir lock para impedir execuções simultâneas.

- **Destino:** `server/src/services/scheduler.js`

### 1.6 Autenticação / Scoping por utilizador
Actualmente a config é single-user (retorna a primeira `CurveConfig`). Implementar identificação do utilizador (API key, token, ou sessão) e fazer scoping de todas as queries por `user_id`.

- **Afecta:** Todos os routes (`expenses`, `curve/*`, `autocomplete`)

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

## Decisões técnicas em aberto

| Questão | Opções | Notas |
|---------|--------|-------|
| Autenticação | API key simples vs JWT vs sessão partilhada com Embers | API key é o mais simples; JWT permite expansão futura |
| IMAP library | `imapflow` vs `node-imap` | `imapflow` é mais moderno e mantido |
| Scheduler | `node-cron` (in-process) vs `bull` + Redis (queue) | `node-cron` suficiente para single-instance; `bull` se precisar de retry/concurrency |
| Password encryption | `crypto.createCipheriv` (AES-256-GCM) | Chave de encriptação em variável de ambiente |
