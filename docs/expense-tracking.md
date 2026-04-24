# Expense Tracking - Documentacao Detalhada

## Visao Geral

O sistema de tracking de despesas do Embers permite registar, categorizar e analisar despesas pessoais. Inclui importacao automatica de despesas via parsing de emails do Curve Card e um sistema de scoring semanal de poupanca.

---

## Arquitetura

```
┌─────────────────────────────────────────────────────────┐
│                      Frontend (React/Redux)              │
│  components/expenses/  │  components/categories/         │
│  components/curve/     │  services/expense.js            │
└────────────────────────┬────────────────────────────────┘
                         │ HTTP (JSON)
┌────────────────────────┴────────────────────────────────┐
│                  Backend (Rails 5)                        │
│  admin/expenses_controller.rb                            │
│  admin/categories_controller.rb                          │
│  models/expense.rb  │  models/category.rb                │
└────────────────────────┬────────────────────────────────┘
                         │
┌────────────────────────┴────────────────────────────────┐
│                    MongoDB (Mongoid)                      │
│  expenses collection  │  categories collection           │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│              curve.py (Script Python)                     │
│  Parsing de emails Curve → POST /admin/expenses/add_expense│
└─────────────────────────────────────────────────────────┘
```

---

## Modelo de Dados

### Expense (`app/models/expense.rb`)

| Campo        | Tipo     | Descricao                                         |
|-------------|----------|----------------------------------------------------|
| `entity`    | String   | Nome do estabelecimento/entidade (ex: "Lidl")      |
| `amount`    | Float    | Valor da despesa em EUR                            |
| `date`      | DateTime | Data e hora da transacao                           |
| `card`      | String   | Cartao usado (nome + ultimos digitos)              |
| `digest`    | String   | Hash SHA-256 unico (previne duplicados)            |
| `category`  | Ref      | Referencia para a categoria (belongs_to)           |
| `user`      | Ref      | Referencia para o utilizador (belongs_to)          |

**Validacoes:**
- `entity`, `amount`, `date`, `card` - obrigatorios
- `digest` - obrigatorio e unico (impede despesas duplicadas)

**Callbacks:**
- `before_create :assign_category` - atribui automaticamente uma categoria com base na entidade

**Timezone em `date`** — a fonte autoritativa e o header MIME `Date:`
do email (`envelope.date` do imapflow), nao o body. O Curve emite no
body uma hora formatada em wall clock mas a TZ desse wall clock
varia por merchant (Celeiro em Europe/Lisbon, Continente e Vodafone
em CEST, Apple em US Eastern, Aliexpress em UTC+2) — por isso nao da
para confiar num so fuso. O header MIME e sempre `+0000` e com
precisao ao segundo, e e isso que alimenta `expense.date` no INSERT.
O body continua a alimentar o `digest`, `entity`, `amount` e `card`.
O frontend renderiza com os getters standard na TZ do browser,
portanto quem abrir em Portugal ve 15:40, em Madrid ve 16:40, em NY
ve 10:40 para a mesma transacao. Rows antigas (guardadas antes deste
fix, com o body interpretado como local do server) sao corrigidas
por `server/scripts/migrate-expense-date-from-imap.js` — liga-se ao
IMAP, le o envelope de cada receipt, compara com o que esta em Mongo
por `digest`, propoe UPDATEs num dry-run e so escreve com
`--apply --yes`.

**Logica de atribuicao de categoria:**
1. Procura uma `Category` cuja lista `entities` contenha o nome da entidade
2. Se nao encontrar, cria/usa a categoria "General"

### Category (`app/models/category.rb`)

| Campo      | Tipo   | Descricao                                          |
|-----------|--------|----------------------------------------------------|
| `name`    | String | Nome da categoria (unico, ex: "Supermercado")      |
| `entities`| Array  | Lista de nomes de entidades associadas a categoria |
| `icon`    | File   | Icone da categoria (Paperclip, JPEG/PNG)           |

**Relacoes:**
- `has_many :expenses`

**Metodos:**
- `total_spent` - soma de todas as despesas desta categoria

---

## Ciclo Mensal Personalizado

O sistema usa um ciclo mensal que comeca no dia **22** de cada mes (em vez do dia 1). Isto reflete-se em:

- **Listagem por defeito**: mostra despesas desde o dia 22 do mes anterior/corrente
- **Relatorios mensais**: agrupados por periodos 22-21
- **Metodo `my_month_start`**: calcula o inicio do "mes" customizado para cada despesa

```ruby
# Se a despesa e dia >= 22, o mes comeca no dia 22 desse mes
# Se a despesa e dia < 22, o mes comeca no dia 22 do mes anterior
def my_month_start
  if date.day >= 22
    Date.new(date.year, date.month, 22)
  else
    Date.new((date - 1.month).year, (date - 1.month).month, 22)
  end
end
```

---

## API Endpoints

### Admin Expenses (`/admin/expenses`)

| Metodo  | Rota                                | Acao                          | Auth     |
|---------|-------------------------------------|-------------------------------|----------|
| GET     | `/admin/expenses.json`              | Listar despesas (com filtros) | Publica* |
| POST    | `/admin/expenses`                   | Criar despesa                 | Admin    |
| POST    | `/admin/expenses/add_expense`       | Criar despesa (externo/Curve) | Publica* |
| PUT     | `/admin/expenses/:id`               | Atualizar despesa             | Admin    |
| DELETE  | `/admin/expenses/:id`               | Eliminar despesa              | Admin    |
| GET     | `/admin/expenses/:id.json`          | Ver despesa                   | Admin    |
| GET     | `/admin/expenses/autocomplete_card` | Autocomplete de cartoes       | Admin    |
| GET     | `/admin/expenses/autocomplete_entity`| Autocomplete de entidades    | Admin    |
| GET     | `/admin/expenses/autocomplete_category`| Autocomplete de categorias | Admin    |
| GET     | `/admin/expenses/monthly_expenses`  | Despesas mensais (12 meses)   | Admin    |
| GET     | `/admin/expenses/get_user_savings_score`| Score de poupanca semanal | Admin    |

*\* `index` e `add_expense` nao requerem autenticacao admin (`skip_before_action`)*

### Admin Categories (`/admin/categories`)

| Metodo  | Rota                      | Acao                |
|---------|---------------------------|---------------------|
| GET     | `/admin/categories.json`  | Listar categorias   |
| POST    | `/admin/categories`       | Criar categoria     |
| PUT     | `/admin/categories/:id`   | Atualizar categoria |
| DELETE  | `/admin/categories/:id`   | Eliminar categoria  |
| GET     | `/admin/categories/:id`   | Ver categoria       |

### Filtros da Listagem de Despesas

| Parametro     | Tipo    | Descricao                                        |
|--------------|---------|--------------------------------------------------|
| `entity`     | String  | Filtro por nome da entidade (regex, case-insensitive)|
| `card`       | String  | Filtro por cartao (regex, case-insensitive)      |
| `amount`     | Float   | Filtro por valor exato                           |
| `category`   | String  | Filtro por nome da categoria                     |
| `show_all`   | Boolean | Mostrar todas as despesas (sem filtro de data)   |
| `show_week`  | Boolean | Mostrar apenas despesas da semana corrente       |
| `sort_column`| String  | Coluna para ordenacao (default: `date`)          |
| `sort_type`  | String  | Tipo de ordenacao: `asc` ou `desc` (default: `desc`)|
| `page`       | Integer | Pagina atual (paginacao)                         |
| `per_page`   | Integer | Itens por pagina (10, 20, 50)                    |

---

## Sistema de Digest (Prevencao de Duplicados)

Cada despesa tem um campo `digest` que e um hash SHA-256 gerado a partir da concatenacao de:

```
entity + amount + date + card
```

- **No frontend** (`form.js`): calculado em tempo real usando `node-forge`
- **No `curve.py`**: calculado com `hashlib.sha256` do Python
- A unicidade do `digest` e validada pelo Mongoid, impedindo a insercao de despesas duplicadas

---

## Parsing de Emails Curve (`curve.py`)

### O que e o Curve Card
O Curve e um cartao agregador que encaminha pagamentos para outros cartoes. Cada transacao gera um email de notificacao com os detalhes da compra.

### Funcionamento do Script

**Tecnologias:** Python 3, BeautifulSoup4, Requests, hashlib, quopri

**Fluxo:**

1. **Leitura**: recebe o conteudo do email via `stdin`
2. **Descodificacao**: descodifica quoted-printable (`quopri`) e converte para UTF-8
3. **Parsing HTML**: usa BeautifulSoup para extrair dados do email:
   - `entity` - nome do estabelecimento (tag `td.u-bold`)
   - `amount` - valor em EUR (segundo `td.u-bold`, remove simbolo `€`)
   - `date` - data da transacao (tag `td.u-greySmaller.u-padding__top--half`)
   - `card` - nome e cartao usado (penultimo `td.u-padding__top--half`)
4. **Digest**: gera hash SHA-256 da concatenacao dos campos extraidos
5. **POST para API**: envia os dados como JSON para `/admin/expenses/add_expense`

### Estrutura do Payload Enviado

```json
{
  "entity": "Lidl",
  "amount": "12.50",
  "date": "25 Dec 2025, 14:30",
  "card": "Filipe **** 1234",
  "digest": "a1b2c3d4e5f6...",
  "user_id": "5e347bc019af471956a1a4dd"
}
```

### Cronjob de Producao

Em producao, o pipeline completo e orquestrado por um cronjob que corre **a cada minuto**:

```cron
* * * * * offlineimap -o && find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -mmin -70 -exec sh -c 'cat "$0" | python /var/www/embers/curve.py' {} \; || true
```

**Decomposicao do cronjob:**

| Parte | Descricao |
|-------|-----------|
| `* * * * *` | Executa a cada minuto |
| `offlineimap -o` | Sincroniza emails via IMAP (modo one-shot, `-o` = run once e sair) |
| `find ... -type f -mmin -70` | Procura ficheiros na pasta "Curve Receipts/new" modificados nos ultimos 70 minutos |
| `-exec sh -c 'cat "$0" \| python ...' {} \;` | Para cada email encontrado, pipe o conteudo para `curve.py` |
| `\|\| true` | Ignora erros para nao bloquear o cron |

**Fluxo completo em producao:**

```
Curve envia email de transacao
        │
        ▼
Outlook365 (mailbox)
        │
        ▼ (offlineimap -o, a cada minuto)
/home/ember/Mail/Outlook365/Curve Receipts/new/
        │
        ▼ (find -mmin -70)
Emails dos ultimos 70 minutos
        │
        ▼ (cat | python curve.py)
curve.py faz parsing do HTML
        │
        ▼ (POST /admin/expenses/add_expense)
Despesa criada no MongoDB
```

**Caminhos relevantes no servidor:**
- **Maildir**: `/home/ember/Mail/Outlook365/Curve Receipts/new/`
- **Script**: `/var/www/embers/curve.py`
- **Configuracao offlineimap**: `~/.offlineimaprc` (configura conta Outlook365 e pastas a sincronizar)

**Porque `-mmin -70` (70 minutos)?**
O cron corre a cada minuto, mas usa uma janela de 70 minutos para garantir que:
- Emails que chegaram entre sincronizacoes nao sao perdidos
- Pequenos atrasos no offlineimap ou no cron nao causam gaps
- Duplicados sao prevenidos pelo sistema de digest (SHA-256) — mesmo que o mesmo email seja processado varias vezes, o `add_expense` rejeita digests repetidos

**Cenarios de bloqueio conhecidos:**
- Se o `offlineimap` bloqueia (timeout IMAP, credenciais expiradas, rede indisponivel), todo o pipeline para porque o `&&` impede a execucao do `find`
- Se o `offlineimap` demora mais de 1 minuto, podem acumular-se processos simultaneos
- Se o servidor de email Outlook365 requer re-autenticacao (OAuth token expirado), o sync falha silenciosamente

### Utilizacao Manual

```bash
# Forcar sync manual de emails e processamento
offlineimap -o && find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -mmin -70 -exec sh -c 'cat "$0" | python /var/www/embers/curve.py' {} \;

# Processar um email especifico
cat /home/ember/Mail/Outlook365/Curve\ Receipts/new/1234567890.eml | python /var/www/embers/curve.py

# Reprocessar todos os emails (sem filtro de tempo) — duplicados sao ignorados pelo digest
find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -exec sh -c 'cat "$0" | python /var/www/embers/curve.py' {} \;
```

### Endpoint Recetor (`add_expense`)

```ruby
# admin/expenses_controller.rb
def add_expense
  expense = Expense.new(expense_params)
  expense.user = User.find_by(id: params[:user_id])
  if expense.save
    expense.user.expenses << expense
    render json: { id: expense.id.to_s }
  else
    render json: { errors: expense.errors.full_messages }, status: :unprocessable_entity
  end
end
```

Este endpoint nao requer autenticacao (`skip_before_action`) para permitir a integracao com o script Python.

---

## Savings Score (Score de Poupanca)

O sistema calcula um score (0-10) baseado no orçamento semanal.

### Janela temporal — **rolling 7 dias** no Curve Sync

> ⚠️ **Divergência consciente face ao Embers.** No Embers a janela é
> semana ISO (`Date.today.beginning_of_week .. end_of_week`, ou seja
> Segunda 00:00 → Domingo 23:59). No Curve Sync a janela é **rolante
> de 168 horas** — `weekStart = now − 7 × 24 h`, ver
> `server/src/services/expenseStats.js:34,210`.

Motivo da mudança (ver também o JSDoc em `computeDashboardStats`):

1. **Sem reset artificial à Segunda.** Em ISO-week, €50 gastos
   Domingo à noite desaparecem do score às 00:01 de Segunda mesmo sem
   mudança de comportamento. Rolante mantém o gasto a pesar 7 dias.
2. **Continuidade.** A janela desliza 1 s a cada segundo — sem saltos
   discretos que tornem o score "cheio" aos Domingos e "vazio" às
   Segundas.
3. **Coerência com o ciclo mensal.** O mês do Curve Sync é ciclo
   custom (dia 22, não calendar month — ver
   [`CLAUDE.md` → Custom Monthly Cycle](../CLAUDE.md)). Combinar
   semana ISO com mês custom seria incongruente.
4. **Timezone-agnóstico.** `beginning_of_week` depende da locale do
   server (Segunda em PT, Domingo em en-US). `now − 168 h` é
   determinístico.
5. **Sinal constante.** Cobre sempre exactamente 168 h — mesma
   quantidade de dados independentemente da hora do pedido.

### Lógica

Fórmula herdada tal-e-qual do Embers:

```js
// server/src/services/expenseStats.js::computeSavingsScore
weekly_budget  = config.weekly_budget  // default 73.75 (= 295/4)
weekly_savings = weekly_budget − weekly_expenses

if (weekly_savings <= 0) score = 0               // overspend
else score = (log(weekly_savings + 1)
            / log(weekly_budget + 1)) * 10
score = clamp(score, 0, 10)                      // 1dp
```

Pequenas divergências de arredondamento/edge-case face ao Embers
(conscientes, não são bugs):

| Situação | Embers | Curve Sync |
|----------|--------|------------|
| Gastou exactamente o budget (`weekly_savings == 0`) | score = 5 | score = 0 |
| Arredondamento final | `score.round` (inteiro) | 1 decimal |

### Endpoints

- **Curve Sync**: alimentado dentro do `meta` de `GET /api/expenses`
  (campos `savings_score`, `weekly_expenses`, `weekly_savings`,
  `weekly_budget`) — não há endpoint dedicado.
- **Embers (legacy)**: `GET /admin/expenses/get_user_savings_score` —
  resposta `{ savings_score, week_expenses, remaining_this_week }`.

---

## Linha de orçamento no gráfico «Evolução por ciclo»

O `CycleTrendCard` do dashboard (ROADMAP §2.8) desenha uma linha
horizontal tracejada sobre as barras com o **equivalente mensal** do
`weekly_budget` configurado pelo utilizador. Com o default
`weekly_budget = €73,75` a linha aterra em **€321**, e um reader que
abra o DevTools a primeira vez vai perguntar-se de onde sai esse valor
— daí esta nota.

### Fórmula

```
monthly_budget = weekly_budget × (30.4375 / 7)
               ≈ weekly_budget × 4.348
```

Fonte canónica: `server/src/services/expenseStats.js` → constante
`WEEKS_PER_MONTH`, consumida em `computeCycleHistory`.

### Exemplos práticos

| `weekly_budget` | `monthly_budget` mostrado na linha |
|-----------------|------------------------------------|
| €73,75 (default, = €295 / 4)  | **€321** |
| €50,00          | €217 |
| €100,00         | €435 |
| €200,00         | €870 |

### Porque **não** é `× 4`

O valor €295 do Embers está descrito como «4 semanas = 1 mês», mas um
mês calendário **médio** tem 30,4375 dias (`365,25 / 12`), ou seja
≈ 4,348 semanas — não 4. Um ciclo real tem 28 (Fevereiro) a 31 dias e a
linha precisa de ser comparável ao gasto desses 28-31 dias. Se
multiplicássemos por 4 a linha aterrava em €295, **abaixo** do gasto
típico de um ciclo de 30-31 dias, e leria-se como overspend crónico
quando na verdade é apenas o denominador errado.

### Porque a linha é **horizontal** (e não por ciclo)

A alternativa seria multiplicar `weekly_budget × cycle_days / 7` para
cada ciclo individual, dando uma linha em «escada» (mais alta nos
meses de 31 dias, mais baixa em Fevereiro). Descartado para a v1
porque:

1. O user pensa no orçamento como «quanto posso gastar por mês», um
   número único — não uma função do calendário.
2. Uma linha horizontal é mais fácil de ler como referência visual; a
   escada adicionaria ruído para um ganho de fidelidade marginal (± 3 %).
3. Manter a linha horizontal preserva a propriedade «barra cima da
   linha = gastou mais do que o orçamento prometia», que se lê em
   meio-segundo.

Se este trade-off mudar (por exemplo, utilizadores com orçamentos
semanais muito apertados onde ± 3 % importa), a mudança é trivial:
expor `cycle_days` em cada row do `cycle_history` payload e trocar
`ReferenceLine` por uma linha `Line` com dados por barra.

### Onde aparece na UI

| Elemento | Conteúdo |
|----------|----------|
| Linha horizontal tracejada no chart | `€{monthly_budget}` |
| Label inline (topo-direita do chart) | `Orçamento €{monthly_budget}` |
| Input em `/curve/config` | `weekly_budget` (editável, save-on-blur) |

O valor é recalculado a cada `GET /api/expenses` — mudar o input da
configuração faz a linha mover-se no próximo refresh da dashboard sem
reload.

---

## Relatorios Mensais

### Endpoint: `GET /admin/expenses/monthly_expenses`

Devolve os totais de despesas dos ultimos 12 meses, agrupados pelo ciclo customizado (dia 22), com percentagem de variacao entre meses.

**Parametros opcionais:**
- `start_date` - data inicio (default: 1 ano atras)
- `end_date` - data fim (default: fim do mes corrente)

**Resposta (exemplo):**
```json
[
  {
    "month_start": "2025-01-22",
    "month": "January 2025",
    "total": 280.50,
    "percentage_increase": -5.2
  },
  {
    "month_start": "2025-02-22",
    "month": "February 2025",
    "total": 310.00,
    "percentage_increase": 10.5
  }
]
```

---

## Frontend (React)

### Componentes

| Ficheiro                             | Descricao                              |
|--------------------------------------|----------------------------------------|
| `components/expenses/index.js`       | Listagem com tabela, filtros, paginacao|
| `components/expenses/form.js`        | Formulario criar/editar despesa        |
| `components/expenses/show.js`        | Vista detalhada de uma despesa         |
| `components/categories/index.js`     | Gestao de categorias                   |
| `components/categories/form.js`      | Formulario de categorias               |
| `components/curve/index.js`          | Vista de assets Curve Card             |

### Servicos JS

| Ficheiro               | Funcoes                                                |
|------------------------|--------------------------------------------------------|
| `services/expense.js`  | `all`, `upsert`, `show`, `destroy`, `autocomplete_card`, `autocomplete_entity`, `autocomplete_category`, `get_savings_score` |
| `services/category.js` | `all`, `upsert`, `show`, `destroy`                     |

### Funcionalidades do Frontend

- **Tabela Material UI**: listagem com colunas Category (icone), Entity, Amount, Date
- **Filtros**: por entidade, cartao, categoria, data, "mostrar tudo", "so esta semana"
- **Ordenacao**: por entity e date (clicavel nas colunas)
- **Paginacao**: com `rc-pagination` (10/20/50 por pagina)
- **Autocomplete**: campos card, entity e category com sugestoes da API
- **Digest automatico**: calculado em tempo real no formulario com `node-forge` (SHA-256)
- **DatePicker**: calendario inline em portugues (pt-PT)
- **Savings Score**: exibido no topo da listagem ("You have a week score of X/10")
- **Dialogo de confirmacao**: antes de eliminar despesas

---

## Ficheiros Relevantes

### Backend
- `app/models/expense.rb` - Modelo Expense (Mongoid)
- `app/models/category.rb` - Modelo Category (Mongoid)
- `app/controllers/admin/expenses_controller.rb` - Controller de despesas
- `app/controllers/admin/categories_controller.rb` - Controller de categorias

### Frontend
- `app/assets/javascripts/app/components/expenses/` - Componentes React
- `app/assets/javascripts/app/components/categories/` - Componentes categorias
- `app/assets/javascripts/app/components/curve/` - Componente Curve
- `app/assets/javascripts/app/services/expense.js` - Servico HTTP despesas
- `app/assets/javascripts/app/services/category.js` - Servico HTTP categorias

### Scripts
- `curve.py` - Parser de emails Curve Card (Python 3)
- `add_expense.sh` - Script rapido para duplicar a primeira despesa (debug/teste)

---

## TODO - Melhorias Futuras do Pipeline Curve

### Prioridade Alta

#### 1. Botao "Sync Curve" no Frontend
**Problema:** Nao ha forma de forcar um re-sync a partir da interface. Se o cronjob bloqueia (offlineimap timeout, OAuth expirado, rede indisponivel), o utilizador nao tem como recuperar sem acesso SSH ao servidor.

**Solucao proposta:**
- Criar endpoint `POST /admin/expenses/sync_curve` no `expenses_controller.rb`
- O endpoint executa o comando do cronjob como subprocess (com timeout)
- Retorna JSON com resultado: emails processados, despesas criadas, erros
- Adicionar botao na pagina Expenses (`components/expenses/index.js`) junto ao botao de refresh
- Mostrar feedback visual: spinner durante sync, toast/snackbar com resultado

```
Frontend (botao "Sync Curve")
    │  POST /admin/expenses/sync_curve
    ▼
Rails Controller
    │  Open3.capture3 com timeout
    │  offlineimap -o && find ... | curve.py
    ▼
JSON response { synced: 3, errors: 0, details: [...] }
    │
    ▼
Frontend atualiza lista de despesas automaticamente
```

#### 2. Timeout e Prevencao de Processos Acumulados
**Problema:** Se o `offlineimap` demora mais de 1 minuto, o cron lanca outro processo. Multiplos processos concorrentes podem corromper o Maildir ou duplicar trabalho. O `stdin.read()` no `curve.py` bloqueia indefinidamente se nao recebe EOF.

**Solucao proposta:**
- Adicionar lock file (`/tmp/curve_sync.lock`) no cronjob com `flock` para impedir execucoes simultaneas
- Adicionar timeout ao `requests.post()` no `curve.py` (ex: 30 segundos)
- Cronjob melhorado:
```cron
* * * * * flock -n /tmp/curve_sync.lock -c 'offlineimap -o && find "/home/ember/Mail/Outlook365/Curve Receipts/new" -type f -mmin -70 -exec sh -c "cat \"\$0\" | timeout 30 python /var/www/embers/curve.py" {} \; || true'
```

#### 3. Proteger Endpoint `add_expense`
**Problema:** O endpoint `add_expense` nao requer autenticacao (`skip_before_action`). Qualquer pessoa pode enviar despesas falsas via POST.

**Solucao proposta:**
- Adicionar autenticacao por API key/token no `curve.py` e validar no controller
- Ou limitar por IP (aceitar apenas `127.0.0.1`/`localhost`) se o script corre no mesmo servidor
- Alternativa: mover o `add_expense` para fora do `skip_before_action` e usar um token dedicado no header

### Prioridade Media

#### 4. Logging Persistente e Registo de Erros
**Problema:** O `curve.py` usa `print()` para stdout. Erros de parsing, falhas de rede e rejeicoes da API perdem-se sem registo. Nao ha forma de diagnosticar problemas sem acesso ao servidor.

**Solucao proposta:**
- Criar modelo `CurveLog` (ou campo em Expense) para registar cada tentativa de import
- O `curve.py` retorna JSON estruturado em vez de strings: `{ "status": "ok", "expense_id": "..." }` ou `{ "status": "error", "reason": "..." }`
- Endpoint no controller para listar logs: `GET /admin/expenses/curve_logs`
- Pagina no frontend para ver historico de syncs com status (sucesso/erro/duplicado)

#### 5. Parsing Mais Resiliente
**Problema:** O parsing depende de classes CSS especificas do template Curve (`u-bold`, `u-greySmaller`, `u-padding__top--half`). Se o Curve muda o template do email, o script quebra silenciosamente e nenhuma despesa e importada.

**Solucao proposta:**
- Adicionar fallbacks com selectores alternativos (buscar por conteudo/posicao, nao so por classe)
- Validar os campos extraidos antes de enviar (entity nao vazia, amount numerico, date parseable)
- Logar o HTML completo quando o parsing falha para facilitar debug
- Adicionar testes unitarios com exemplos de emails Curve (fixtures)

#### 6. User ID Dinamico
**Problema:** O `user_id` esta hardcoded no `curve.py` (`5e347bc019af471956a1a4dd`). Nao suporta multiplos utilizadores nem ambientes diferentes (dev vs prod).

**Solucao proposta:**
- Passar `user_id` como argumento do script: `python curve.py --user-id=XXX`
- Ou usar variavel de ambiente: `CURVE_USER_ID`
- Ou derivar o utilizador a partir do endereco de email do remetente

### Prioridade Baixa

#### 7. Rake Task para Sync Manual
**Problema:** O sync so pode ser feito via cronjob ou SSH. Uma rake task permitiria integrar com o ecossistema Rails e facilitar debug.

**Solucao proposta:**
```ruby
# lib/tasks/curve.rake
namespace :curve do
  desc "Sync Curve emails e importar despesas"
  task sync: :environment do
    # Executa offlineimap + curve.py
  end
end
```
- Utilizavel via `rake curve:sync` na consola
- Reutilizavel pelo endpoint do controller (DRY)

#### 8. Migrar de offlineimap para IMAP Directo no Python
**Problema:** A dependencia do offlineimap adiciona uma camada extra que pode falhar independentemente. O offlineimap esta descontinuado (ultimo release em 2020).

**Solucao proposta:**
- Usar `imaplib` (stdlib Python) ou `imapclient` para ler emails directamente
- O script faz login IMAP, le emails da pasta "Curve Receipts", processa, e marca como lidos
- Elimina a dependencia do offlineimap e do Maildir local
- Permite saber exactamente quais emails ja foram processados (flag IMAP `\Seen`)

#### 9. Reactivar Pagina Curve no Frontend
**Problema:** A sidebar mostra "Curve Card (disabled)" e o componente `curve/index.js` apenas lista assets genericos (CoinCard), sem relacao com o pipeline de emails. Os sub-componentes `curve/form.js` e `curve/show.js` sao copias dos componentes de addresses, nunca adaptados para o Curve.

**Solucao proposta:** Redesenhar a pagina Curve como painel de configuracao e dashboard do pipeline (ver seccao abaixo).

---

## TODO - Painel "Curve Card" (Configuracao e Dashboard)

### Contexto

A pagina `#/curve` foi pensada como painel de configuracao para associar a conta de email Curve ao sistema de import automatico de despesas. Actualmente esta desactivada na sidebar ("Curve Card (disabled)") e o componente apenas lista assets genericos sem funcionalidade real.

Ja existe um padrao na plataforma para formularios de configuracao de email — o componente `pages/email_sender.js` com o servico `services/email_sender.js` — que pode servir de referencia para o painel Curve.

### 9a. Modelo `CurveConfig` (Backend)

Criar um modelo Mongoid para guardar a configuracao do pipeline Curve por utilizador.

```ruby
# app/models/curve_config.rb
class CurveConfig
  include Mongoid::Document
  include Mongoid::Timestamps

  field :imap_server, type: String, default: 'outlook.office365.com'
  field :imap_port, type: Integer, default: 993
  field :imap_username, type: String          # email Outlook/Gmail
  field :imap_password, type: String          # password ou app password (encriptada)
  field :imap_folder, type: String, default: 'Curve Receipts'
  field :sync_enabled, type: Boolean, default: false
  field :sync_interval_minutes, type: Integer, default: 5
  field :last_sync_at, type: DateTime
  field :last_sync_status, type: String       # "ok", "error", "partial"
  field :last_sync_message, type: String      # detalhes do resultado
  field :emails_processed, type: Integer, default: 0
  field :lookback_minutes, type: Integer, default: 70

  belongs_to :user

  validates :imap_username, presence: true, if: :sync_enabled?
  validates :imap_folder, presence: true
end
```

**Campos de configuracao** (editaveis pelo utilizador):
- Servidor IMAP, porta, credenciais
- Pasta de email onde chegam os recibos Curve
- Toggle on/off do sync automatico
- Intervalo de sync e janela de lookback

**Campos de estado** (actualizados automaticamente):
- Data/hora do ultimo sync
- Status e mensagem do ultimo sync
- Total de emails processados

### 9b. Controller `CurveConfigController` (Backend)

```ruby
# app/controllers/admin/curve_configs_controller.rb
class Admin::CurveConfigsController < Admin::BaseController
  # GET /admin/curve_config - mostra config do user actual
  def show
    config = current_user.curve_config || CurveConfig.new(user: current_user)
    render json: { curve_config: config.to_json }
  end

  # PUT /admin/curve_config - actualiza config
  def update
    config = current_user.curve_config || CurveConfig.new(user: current_user)
    if config.update(curve_config_params)
      render json: { message: 'Curve config updated.', curve_config: config.to_json }
    else
      render json: { errors: config.errors.full_messages }, status: :unprocessable_entity
    end
  end

  # POST /admin/curve_config/sync - forca sync manual
  def sync
    config = current_user.curve_config
    unless config&.imap_username.present?
      render json: { errors: ['Curve not configured.'] }, status: :unprocessable_entity
      return
    end
    # Executa sync em subprocess com timeout
    result = CurveSyncService.new(config).run
    render json: result
  end

  # GET /admin/curve_config/logs - historico de syncs
  def logs
    logs = current_user.curve_logs.order(created_at: :desc).limit(50)
    render json: logs.map(&:to_json)
  end
end
```

**Rotas:**
```ruby
# config/routes.rb (dentro do namespace :admin)
resource :curve_config, only: [:show, :update] do
  post :sync
  get :logs
end
```

### 9c. Servico JS `services/curve.js` (Frontend)

```javascript
// app/assets/javascripts/app/services/curve.js
import http from './http';

export function show() {
  return http.get({ url: '/admin/curve_config.json' });
}

export function update(config) {
  let body = new FormData();
  body.append('imap_server', config.imap_server || '');
  body.append('imap_port', config.imap_port || 993);
  body.append('imap_username', config.imap_username || '');
  if (config.imap_password) body.append('imap_password', config.imap_password);
  body.append('imap_folder', config.imap_folder || '');
  body.append('sync_enabled', config.sync_enabled);
  body.append('sync_interval_minutes', config.sync_interval_minutes || 5);
  body.append('lookback_minutes', config.lookback_minutes || 70);
  return http.put({ url: '/admin/curve_config', body });
}

export function sync() {
  return http.post({ url: '/admin/curve_config/sync' });
}

export function logs() {
  return http.get({ url: '/admin/curve_config/logs.json' });
}
```

### 9d. Redesenhar `components/curve/index.js` (Frontend)

Transformar a pagina Curve num dashboard com 3 seccoes:

**Seccao 1 — Status e Accoes Rapidas**
```
┌─────────────────────────────────────────────────────────────┐
│  💳 Curve Card                                              │
│                                                             │
│  Status: ● Activo (ultimo sync: ha 3 minutos, 2 importadas)│
│  [  🔄 Sync Now  ]   [ ⚙ Settings ]                        │
│                                                             │
│  Emails processados (total): 347                            │
│  Proxima sincronizacao: 14:35                               │
└─────────────────────────────────────────────────────────────┘
```
- Indicador verde/vermelho/cinza (activo/erro/desligado)
- Botao "Sync Now" que chama `POST /admin/curve_config/sync`
- Spinner durante o sync, toast com resultado ("3 importadas, 1 duplicada, 0 erros")
- Link para Settings (formulario de configuracao)

**Seccao 2 — Ultimas Despesas Importadas via Curve**
```
┌─────────────────────────────────────────────────────────────┐
│  Ultimas importacoes                                        │
│                                                             │
│  ● Lidl              12.50 EUR    29 Mar 2026    ✓ Criada   │
│  ● Galp              45.00 EUR    28 Mar 2026    ✓ Criada   │
│  ● Worten            89.99 EUR    28 Mar 2026    ⚠ Duplicada│
│  ● ???               --.- EUR     27 Mar 2026    ✗ Erro     │
└─────────────────────────────────────────────────────────────┘
```
- Lista das ultimas N despesas importadas pelo pipeline (nao manualmente)
- Status por despesa: criada, duplicada (digest repetido), erro (parsing falhou)
- Clicar numa despesa abre `#/expense/:id`

**Seccao 3 — Formulario de Configuracao (expandivel ou em rota separada)**

Seguindo o padrao do `email_sender.js`:

```
┌─────────────────────────────────────────────────────────────┐
│  ⚙ Curve Email Settings                                     │
│                                                             │
│  IMAP Server:     [ outlook.office365.com    ]              │
│  IMAP Port:       [ 993                      ]              │
│  Username/Email:  [ user@outlook.com         ]              │
│  Password:        [ ••••••••                 ]              │
│  Email Folder:    [ Curve Receipts           ]              │
│                                                             │
│  Sync Automatico: [ ON  ]                                   │
│  Intervalo:       [ 5 ] minutos                             │
│  Lookback:        [ 70 ] minutos                            │
│                                                             │
│  [ Test Connection ]          [ Save ]                      │
└─────────────────────────────────────────────────────────────┘
```
- Campos IMAP seguindo o padrao visual do `EmailSenderForm`
- Toggle para activar/desactivar sync automatico
- Botao "Test Connection" que valida credenciais IMAP sem importar (endpoint dedicado)
- Guardar actualiza o `CurveConfig` e activa/desactiva o cronjob

### 9e. Actualizar Sidebar

Remover "(disabled)" e activar o link quando existir `CurveConfig`:

```javascript
// components/layouts/sidebar.js
<ListItem key={5} onClick={this.handleToggle} href='#/curve' leftIcon={<ActionCreditCard />}>
    Curve Card
</ListItem>
```

### 9f. Modelo `CurveLog` para Historico de Syncs

```ruby
# app/models/curve_log.rb
class CurveLog
  include Mongoid::Document
  include Mongoid::Timestamps

  field :status, type: String          # "ok", "error", "duplicate", "parse_error"
  field :message, type: String
  field :email_filename, type: String  # nome do ficheiro do email
  field :entity, type: String          # entidade extraida (se parsing ok)
  field :amount, type: Float           # valor extraido (se parsing ok)
  field :digest, type: String          # digest calculado
  field :expense_id, type: String      # ID da expense criada (se sucesso)
  field :error_detail, type: String    # stack trace ou HTML truncado (se erro)

  belongs_to :user
  belongs_to :curve_config, optional: true
end
```

Permite:
- Diagnosticar erros de parsing sem acesso SSH
- Ver quais emails foram processados e com que resultado
- Reprocessar emails com erro a partir do frontend

### Resumo de Ficheiros a Criar/Alterar

| Accao   | Ficheiro                                             | Descricao                              |
|---------|------------------------------------------------------|----------------------------------------|
| Criar   | `app/models/curve_config.rb`                         | Modelo de configuracao Curve           |
| Criar   | `app/models/curve_log.rb`                            | Modelo de log de syncs                 |
| Criar   | `app/controllers/admin/curve_configs_controller.rb`  | Controller de config + sync + logs     |
| Criar   | `app/services/curve_sync_service.rb`                 | Servico que orquestra offlineimap + curve.py |
| Criar   | `app/assets/javascripts/app/services/curve.js`       | Servico HTTP frontend                  |
| Reescrever | `app/assets/javascripts/app/components/curve/index.js` | Dashboard (status + importacoes + config) |
| Alterar | `app/assets/javascripts/app/components/layouts/sidebar.js` | Remover "(disabled)"             |
| Alterar | `config/routes.rb`                                   | Adicionar rotas `curve_config`         |
| Alterar | `curve.py`                                           | Retornar JSON estruturado, aceitar args |

---

## Hipotese: Curve Sync como Servico Standalone

### Motivacao

O pipeline Curve (ler emails → parsing HTML → criar despesas) e funcionalidade auto-contida com poucos pontos de contacto com o Embers. Isola-lo num microservico traz vantagens claras em resiliencia, escalabilidade e reutilizacao.

### Analise de Acoplamento Actual

O `curve.py` tem apenas **2 pontos de contacto** com o Embers:

| Dependencia           | Direcao           | Detalhe                                          |
|-----------------------|-------------------|--------------------------------------------------|
| `POST /admin/expenses/add_expense` | curve → Embers | Unico endpoint que o script chama          |
| `user_id` hardcoded   | curve → Embers    | ID do utilizador MongoDB do Embers               |

O pipeline **nao depende** de:
- Sessoes Rails, cookies, ou auth tokens
- Modelos Mongoid (nao importa a gem, nao acede ao MongoDB directamente)
- Nenhum componente frontend do Embers
- Nenhuma configuracao Rails (Figaro, secrets, etc.)

**Conclusao: o desacoplamento ja e quase total.** O script ja funciona como um processo externo que comunica via HTTP. Transformar isto num servico standalone seria uma evolucao natural, nao uma refactorizacao pesada.

### Arquitectura Proposta: Python FastAPI + SQLite/MongoDB

FastAPI e a escolha natural porque:
- O core do parsing ja e Python (BeautifulSoup, quopri, hashlib)
- FastAPI e async-native — ideal para operacoes IMAP que bloqueiam
- Inclui Swagger/OpenAPI automatico (substituindo o Try API do Rails)
- Leve, sem overhead de framework pesado
- Facil de containerizar

```
┌─────────────────────────────────────────────────────────────────┐
│                    CURVE SYNC SERVICE (standalone)               │
│                    Python 3 + FastAPI                            │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  ┌──────────────┐   │
│  │  IMAP    │  │  Parser  │  │  Webhook  │  │  Scheduler   │   │
│  │  Reader  │→ │  Engine  │→ │  Sender   │  │  (APScheduler│   │
│  │          │  │          │  │          │  │  ou Celery)  │   │
│  └──────────┘  └──────────┘  └───────────┘  └──────────────┘   │
│        ↑                           │               │            │
│  ┌─────┴──────┐                    │          ┌────┴────┐       │
│  │  Email     │                    │          │  Cron   │       │
│  │  Providers │                    │          │  Jobs   │       │
│  │ (Outlook,  │                    │          └─────────┘       │
│  │  Gmail...) │                    │                            │
│  └────────────┘                    ▼                            │
│                          ┌─────────────────┐                    │
│                          │  SQLite/MongoDB  │                    │
│                          │  (configs, logs) │                    │
│                          └─────────────────┘                    │
│                                                                 │
│  API Endpoints:                                                 │
│  POST /api/sync          - forcar sync manual                   │
│  GET  /api/status        - estado actual do sync                │
│  GET  /api/logs          - historico de processamento           │
│  GET  /api/config        - ver configuracao                     │
│  PUT  /api/config        - alterar configuracao                 │
│  POST /api/test-connection - testar ligacao IMAP                │
│  GET  /api/health        - health check                         │
│  GET  /docs              - Swagger UI (auto-gerado)             │
└─────────────────────────────────────────────────────────────────┘
         │
         │  webhook HTTP (POST com expense data)
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    EMBERS (plataforma principal)                 │
│                    Ruby on Rails                                │
│                                                                 │
│  POST /admin/expenses/add_expense  ← recebe despesas do Curve  │
│  POST /api/v1/webhook/curve        ← (novo) webhook autenticado│
└─────────────────────────────────────────────────────────────────┘
```

### Estrutura do Servico

```
curve-sync-service/
├── app/
│   ├── main.py                  # FastAPI app, startup, routers
│   ├── config.py                # Settings via Pydantic (env vars)
│   ├── models/
│   │   ├── sync_config.py       # Configuracao IMAP por tenant
│   │   ├── sync_log.py          # Log de cada email processado
│   │   └── database.py          # Ligacao SQLite/MongoDB
│   ├── services/
│   │   ├── imap_reader.py       # Ler emails via IMAP (substitui offlineimap)
│   │   ├── email_parser.py      # Parsing HTML Curve (logica actual do curve.py)
│   │   ├── webhook_sender.py    # POST para Embers (ou qualquer destino)
│   │   └── scheduler.py         # Sync periodico (APScheduler)
│   ├── routers/
│   │   ├── sync.py              # POST /api/sync, GET /api/status
│   │   ├── config.py            # GET/PUT /api/config
│   │   └── logs.py              # GET /api/logs
│   └── parsers/
│       ├── curve_v1.py          # Parser actual (u-bold, u-greySmaller)
│       └── base.py              # Interface base para suportar novos templates
├── tests/
│   ├── fixtures/                # Emails Curve de exemplo (.eml)
│   │   ├── curve_receipt_v1.eml
│   │   └── curve_receipt_edge_cases.eml
│   ├── test_parser.py
│   ├── test_imap_reader.py
│   └── test_webhook.py
├── Dockerfile
├── docker-compose.yml
├── requirements.txt
├── .env.example
└── README.md
```

### Componentes Chave

#### 1. IMAP Reader (substitui offlineimap)

```python
# app/services/imap_reader.py
import imaplib
import email

class IMAPReader:
    def __init__(self, server, port, username, password, folder):
        self.server = server
        self.port = port
        self.username = username
        self.password = password
        self.folder = folder

    def connect(self):
        """Liga ao servidor IMAP. Raise exception se falhar."""
        self.mail = imaplib.IMAP4_SSL(self.server, self.port)
        self.mail.login(self.username, self.password)
        self.mail.select(self.folder)

    def fetch_unseen(self):
        """Devolve lista de emails nao lidos."""
        _, message_ids = self.mail.search(None, 'UNSEEN')
        emails = []
        for msg_id in message_ids[0].split():
            _, msg_data = self.mail.fetch(msg_id, '(RFC822)')
            raw_email = msg_data[0][1]
            emails.append({
                'id': msg_id,
                'raw': raw_email,
                'parsed': email.message_from_bytes(raw_email)
            })
        return emails

    def mark_as_seen(self, msg_id):
        """Marca email como lido apos processamento com sucesso."""
        self.mail.store(msg_id, '+FLAGS', '\\Seen')

    def test_connection(self):
        """Testa se as credenciais e pasta sao validas."""
        try:
            self.connect()
            self.mail.logout()
            return {"status": "ok", "message": "Connection successful"}
        except Exception as e:
            return {"status": "error", "message": str(e)}
```

**Vantagens sobre offlineimap:**
- Sem Maildir local (sem disco, sem `find -mmin`)
- Flag `UNSEEN` substitui a janela de 70 minutos — sabe exactamente quais ja foram processados
- `mark_as_seen` so apos sucesso — se o parsing falha, o email fica pendente para retry
- `test_connection` permite validar credenciais a partir do frontend

#### 2. Email Parser (logica do curve.py modularizada)

```python
# app/services/email_parser.py
from bs4 import BeautifulSoup
import quopri
import hashlib

class CurveEmailParser:
    """Extrai dados de despesa de um email Curve."""

    def parse(self, raw_html: str) -> dict:
        decoded = quopri.decodestring(raw_html).decode('utf-8')
        soup = BeautifulSoup(decoded, 'html.parser')

        entity_tag = soup.find('td', class_='u-bold')
        if not entity_tag:
            raise ParseError("Tag 'entity' (td.u-bold) nao encontrada")

        amount_tag = entity_tag.find_next_sibling('td', class_='u-bold')
        date_tag = soup.find('td', class_='u-greySmaller u-padding__top--half')
        card_tag = soup.find_all('td', class_='u-padding__top--half')[-2]

        entity = entity_tag.get_text(strip=True)
        amount = amount_tag.get_text(strip=True).replace('€', '')
        date = date_tag.get_text(strip=True)
        card = ' '.join(card_tag.stripped_strings)

        digest = hashlib.sha256(
            f"{entity}{amount}{date}{card}".encode()
        ).hexdigest()

        return {
            "entity": entity,
            "amount": amount,
            "date": date,
            "card": card,
            "digest": digest
        }

class ParseError(Exception):
    pass
```

#### 3. Webhook Sender (comunicacao com Embers)

```python
# app/services/webhook_sender.py
import httpx

class WebhookSender:
    def __init__(self, target_url, api_key=None, timeout=30):
        self.target_url = target_url
        self.api_key = api_key
        self.timeout = timeout

    async def send(self, expense_data: dict) -> dict:
        headers = {}
        if self.api_key:
            headers["X-Curve-API-Key"] = self.api_key

        async with httpx.AsyncClient() as client:
            response = await client.post(
                self.target_url,
                json=expense_data,
                headers=headers,
                timeout=self.timeout
            )

        return {
            "status": "ok" if response.is_success else "error",
            "status_code": response.status_code,
            "response": response.json() if response.is_success else response.text
        }
```

**O `target_url` e configuravel** — pode apontar para:
- Embers: `https://embers.brasume.com/admin/expenses/add_expense`
- Outro sistema qualquer que aceite o mesmo payload
- Multiplos destinos em paralelo (ex: Embers + Google Sheets + Telegram)

#### 4. Scheduler (substitui o cronjob do sistema)

```python
# app/services/scheduler.py
from apscheduler.schedulers.asyncio import AsyncIOScheduler

scheduler = AsyncIOScheduler()

async def sync_job(config_id: str):
    """Job executado periodicamente por config."""
    config = await get_config(config_id)
    reader = IMAPReader(...)
    parser = CurveEmailParser()
    sender = WebhookSender(config.target_url, config.api_key)

    reader.connect()
    emails = reader.fetch_unseen()

    for mail in emails:
        try:
            expense = parser.parse(mail['raw'])
            expense['user_id'] = config.embers_user_id
            result = await sender.send(expense)
            reader.mark_as_seen(mail['id'])
            await save_log(config, mail, "ok", result)
        except ParseError as e:
            await save_log(config, mail, "parse_error", str(e))
        except Exception as e:
            await save_log(config, mail, "error", str(e))
```

### Integracao com Embers

#### Opcao A: Embers consome a API do Curve Service (pull)

O frontend Embers chama directamente o servico Curve (se estiver exposto ou via proxy):

```
Embers Frontend  →  GET /api/status    →  Curve Service
Embers Frontend  →  POST /api/sync     →  Curve Service
Embers Frontend  →  GET /api/logs      →  Curve Service
```

**Preco:** Configurar CORS no servico, ou proxy via Rails (`/admin/curve_proxy/*`).

#### Opcao B: Curve Service envia para Embers via webhook (push)

O servico Curve envia despesas para o Embers. O frontend Embers apenas mostra o resultado:

```
Curve Service  →  POST /api/v1/webhook/curve  →  Embers Backend
Embers Frontend  →  GET /admin/expenses       →  Embers Backend (dados ja la estao)
```

**Preco:** Criar endpoint webhook autenticado no Embers. O frontend Curve (config/dashboard) fica no proprio servico ou como iframe no Embers.

#### Opcao C: Hibrida (recomendada)

```
┌──────────────────────────────────────────────────────────┐
│                      EMBERS FRONTEND                      │
│                                                          │
│  Expenses page           Curve Dashboard                 │
│  (dados do Embers DB)    (chama Curve Service API)       │
│       │                       │                          │
│       ▼                       ▼                          │
│  GET /admin/expenses     GET /curve-api/status            │
│                          POST /curve-api/sync             │
│                          GET /curve-api/logs              │
│                          PUT /curve-api/config             │
└──────┬──────────────────────────┬────────────────────────┘
       │                          │
       ▼                          ▼  (proxy nginx ou Rails)
┌──────────────┐          ┌──────────────────┐
│    EMBERS    │◄─webhook─│  CURVE SERVICE   │
│   (Rails)    │  (push)  │  (FastAPI)       │
│              │          │                  │
│  MongoDB     │          │  SQLite (config, │
│  (expenses)  │          │   logs)          │
└──────────────┘          └──────────────────┘
```

- **Despesas** ficam no MongoDB do Embers (source of truth)
- **Config e logs** ficam no Curve Service (SQLite leve, sem dependencia do Mongo do Embers)
- **Sync automatico**: Curve Service le IMAP, envia webhook para Embers
- **Sync manual**: frontend chama Curve Service API, que faz o mesmo
- **Dashboard Curve**: frontend Embers chama API do Curve Service via proxy

### Deploy

```yaml
# docker-compose.yml
services:
  curve-sync:
    build: ./curve-sync-service
    ports:
      - "8100:8000"
    environment:
      - DATABASE_URL=sqlite:///data/curve.db
      - EMBERS_WEBHOOK_URL=https://embers.brasume.com/api/v1/webhook/curve
      - EMBERS_API_KEY=${CURVE_API_KEY}
    volumes:
      - curve-data:/data
    restart: unless-stopped

volumes:
  curve-data:
```

```nginx
# nginx.conf (proxy no Embers)
location /curve-api/ {
    proxy_pass http://localhost:8100/api/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

### Pros vs Contras do Standalone

#### Pros

| Vantagem                    | Detalhe                                                                  |
|-----------------------------|--------------------------------------------------------------------------|
| **Isolamento de falhas**    | Se o Curve Service crasha, o Embers continua a funcionar normalmente     |
| **Deploy independente**     | Actualizar o parser nao requer redeploy do Rails                         |
| **Elimina offlineimap**     | IMAP directo em Python, sem dependencia descontinuada                    |
| **Testabilidade**           | Testes unitarios do parser com fixtures de emails, sem Rails             |
| **Reutilizavel**            | Pode servir outros sistemas alem do Embers (ex: Google Sheets, Notion)   |
| **Async nativo**            | FastAPI + asyncio ideal para I/O IMAP, sem bloquear                      |
| **Sem processos acumulados**| Scheduler interno com lock, substitui o cronjob fragil                   |
| **Observabilidade**         | Logs estruturados, health check, Swagger UI built-in                     |
| **Containerizavel**         | Docker simples, um unico container leve (~50MB)                          |
| **Multi-provider**          | Suportar Gmail, Outlook, etc. com a mesma interface IMAP                 |

#### Contras

| Desvantagem                       | Detalhe                                                          |
|-----------------------------------|------------------------------------------------------------------|
| **Mais um servico para manter**   | Novo deploy, monitorizar, actualizar dependencias                |
| **Rede entre servicos**           | O webhook pode falhar (timeout, DNS). Precisa de retry queue     |
| **Dois datastores**               | SQLite no Curve + MongoDB no Embers. Pode haver inconsistencia   |
| **Credenciais IMAP em dois sitios** | Se mantiver tambem o cronjob como fallback, sao duas configs   |
| **Overengineering se so para 1 user** | O Embers e pessoal. Um microservico pode ser excessivo para uso individual |
| **Complexidade de proxy**         | Configurar nginx/Rails para proxy adiciona uma camada            |
| **Latencia adicional**            | Webhook HTTP vs insercao directa no MongoDB (negligivel na pratica) |

### Alternativa Leve: Manter Monolito com Melhorias

Se o overhead de um servico separado nao justificar, a alternativa e manter tudo no Embers com estas melhorias minimas:

1. Substituir `offlineimap` por `imaplib` dentro do `curve.py`
2. Adicionar `flock` e `timeout` ao cronjob
3. Criar endpoint `sync_curve` no Rails que chama o script melhorado
4. Botao "Sync Now" no frontend

Isto resolve 80% dos problemas (bloqueio, feedback, controlo) sem a complexidade de um microservico.
