# MongoDB Schema - Embers Reference para Curve Standalone

## Ligacao a Base de Dados

O standalone liga-se a **mesma instancia MongoDB** do Embers.

```
# Producao
Host: 127.0.0.1:27017
Database: embers_db
Auth source: admin

# Desenvolvimento
Host: 127.0.0.1:27017
Database: embers_db_dev
Auth source: admin (sem user/password)
```

Referencia: `docs/embers-reference/config/mongoid.yml_example`

---

## Collections Existentes do Embers (NAO ALTERAR SCHEMA)

O standalone acede a estas collections em modo **read** ou **insert-only**. Nunca deve alterar a estrutura dos documentos existentes.

### Collection: `users`

**Acesso:** READ-ONLY (validar user_id)

```javascript
// Mongoose schema (referencia, nao modificar documentos existentes)
const UserRefSchema = new mongoose.Schema({
  email:              { type: String, required: true, unique: true },
  encrypted_password: { type: String },
  salt:               { type: String },
  role:               { type: String, default: 'user', enum: ['admin', 'user'] },
  last_activity_at:   { type: Date },
  asset_ids:          [{ type: mongoose.Schema.Types.ObjectId, ref: 'Asset' }],  // HABTM
}, { timestamps: true, collection: 'users' });
```

**Campos que o standalone usa:**
- `_id` — para associar despesas ao user
- `email` — para exibir no dashboard

**Relacoes Mongoid originais:**
```ruby
has_many :expenses        # user_id dentro de cada expense
has_many :addresses
has_many :sessions
has_many :goals
has_many :evolutions
has_and_belongs_to_many :assets  # array asset_ids no documento user
```

---

### Collection: `categories`

**Acesso:** READ-ONLY (auto-atribuir categoria a despesas)

```javascript
const CategoryRefSchema = new mongoose.Schema({
  name:       { type: String, required: true, unique: true },
  entities:   { type: [String], default: [] },
  // icon: Paperclip attachment (ficheiro no filesystem, nao no MongoDB)
  //       Armazenado como path em subcampo icon_file_name, icon_content_type, etc.
}, { timestamps: true, collection: 'categories' });
```

**Campos que o standalone usa:**
- `_id` — para associar como `category_id` na expense
- `name` — para exibir no dashboard
- `entities[]` — array de nomes de entidades para matching automatico

**Logica de auto-assign (portar do Embers):**
```javascript
// Equivalente ao assign_category do expense.rb
async function assignCategory(entityName) {
  // 1. Procurar categoria cujo array entities contenha o nome da entidade
  const category = await Category.findOne({ entities: entityName });
  if (category) return category._id;

  // 2. Se nao encontrar, usar/criar categoria "General"
  const general = await Category.findOneAndUpdate(
    { name: 'General' },
    { name: 'General' },
    { upsert: true, new: true }
  );
  return general._id;
}
```

---

### Collection: `expenses`

**Acesso:** READ (verificar duplicados) + INSERT (criar novas despesas)

```javascript
const ExpenseSchema = new mongoose.Schema({
  entity:      { type: String, required: true },
  amount:      { type: Number, required: true },
  date:        { type: Date,   required: true },
  card:        { type: String, required: true },
  digest:      { type: String, required: true, unique: true },
  user_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  category_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  // source: campo novo opcional para identificar origem (standalone nao deve
  //         adicionar campos ao schema existente sem coordenar com o Embers)
}, { timestamps: true, collection: 'expenses' });

// Index critico — previne duplicados
ExpenseSchema.index({ digest: 1 }, { unique: true });
```

**Campos que o standalone escreve:**
- `entity` — nome do estabelecimento (parsed do email)
- `amount` — valor em EUR (parsed do email)
- `date` — data da transacao (parsed do email)
- `card` — cartao usado (parsed do email)
- `digest` — SHA-256 de `entity + amount + date + card` (dedup)
- `user_id` — ObjectId do user (vem da CurveConfig)
- `category_id` — ObjectId da categoria (auto-assigned)
- `created_at`, `updated_at` — geridos pelo Mongoose timestamps

**IMPORTANTE — Consistencia com o Embers:**

O Embers (Rails/Mongoid) espera estes nomes de campo exactos. O Mongoose por defeito cria `createdAt`/`updatedAt` (camelCase), mas o Mongoid usa `created_at`/`updated_at` (snake_case). Configurar:

```javascript
const ExpenseSchema = new mongoose.Schema({ /* ... */ }, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'expenses'
});
```

**Relacoes no MongoDB (como o Mongoid as guarda):**

O Mongoid guarda `belongs_to` como campo `<nome>_id` (ObjectId) no proprio documento:
```json
{
  "_id": ObjectId("..."),
  "entity": "Lidl",
  "amount": 12.50,
  "date": ISODate("2026-03-29T14:30:00Z"),
  "card": "Filipe **** 1234",
  "digest": "a1b2c3d4...",
  "user_id": ObjectId("5e347bc019af471956a1a4dd"),
  "category_id": ObjectId("60a1b2c3d4e5f6..."),
  "created_at": ISODate("2026-03-29T15:00:00Z"),
  "updated_at": ISODate("2026-03-29T15:00:00Z")
}
```

---

## Collections Novas (ownership do Standalone)

Estas collections sao criadas e geridas exclusivamente pelo Curve Standalone. O Embers nao as acede.

### Collection: `curve_configs`

```javascript
const CurveConfigSchema = new mongoose.Schema({
  user_id:                { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  imap_server:            { type: String, default: 'outlook.office365.com' },
  imap_port:              { type: Number, default: 993 },
  imap_username:          { type: String },
  imap_password:          { type: String },  // encriptar com crypto.createCipheriv
  imap_folder:            { type: String, default: 'Curve Receipts' },
  use_maildir:            { type: Boolean, default: true },
  maildir_path:           { type: String, default: '/home/ember/Mail/Outlook365/Curve Receipts/new' },
  sync_enabled:           { type: Boolean, default: false },
  sync_interval_minutes:  { type: Number, default: 5 },
  lookback_minutes:       { type: Number, default: 70 },
  last_sync_at:           { type: Date },
  last_sync_status:       { type: String, enum: ['ok', 'error', 'partial', null] },
  last_sync_message:      { type: String },
  emails_processed_total: { type: Number, default: 0 },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'curve_configs'
});
```

### Collection: `curve_logs`

```javascript
const CurveLogSchema = new mongoose.Schema({
  user_id:        { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  config_id:      { type: mongoose.Schema.Types.ObjectId, ref: 'CurveConfig' },
  status:         { type: String, enum: ['ok', 'duplicate', 'parse_error', 'error'], required: true },
  message:        { type: String },
  email_filename: { type: String },
  entity:         { type: String },
  amount:         { type: Number },
  digest:         { type: String },
  expense_id:     { type: mongoose.Schema.Types.ObjectId, ref: 'Expense' },
  // ROADMAP §2.10.1 — bulk toggle drill-down. Populated only on
  // `expense_excluded_from_cycle` / `expense_included_in_cycle` rows
  // with N > 1, capped at 100 ids server-side. Empty for single-row
  // audits (those use `expense_id`) and for every other action.
  affected_expense_ids: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Expense' }],
  error_detail:   { type: String },
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'curve_logs'
});

// TTL index — apagar logs com mais de 90 dias automaticamente
CurveLogSchema.index({ created_at: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });
```

### Collection: `curve_expense_exclusions`

Flag per-user que marca uma despesa como «nao contar para o ciclo /
Savings Score» (ROADMAP §2.10). Schema de `expenses` fica intocado —
o DELETE continua proibido por CLAUDE.md → Access Rules; a exclusao
vive out-of-band neste collection dedicado, exactamente como o
`curve_category_overrides`.

```javascript
const CurveExpenseExclusionSchema = new mongoose.Schema({
  user_id:    { type: mongoose.Schema.Types.ObjectId, ref: 'User',    required: true },
  expense_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Expense', required: true },
  note:       { type: String, trim: true, maxlength: 200 },  // opcional, nao exposto na UI MVP
}, {
  timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  collection: 'curve_expense_exclusions'
});

// Unique compound — idempotencia do POST /api/expenses/exclusions.
// Duplicados silenciosos via upsert (`skipped` no response).
CurveExpenseExclusionSchema.index({ user_id: 1, expense_id: 1 }, { unique: true });

// Hot query do `computeDashboardStats` — carrega todas as exclusoes
// do user por fetch.
CurveExpenseExclusionSchema.index({ user_id: 1 });
```

- **Endpoints:** `POST /api/expenses/exclusions` + `DELETE /api/expenses/exclusions`, body `{ expense_ids: [...] }`, cap 500. Resposta: `{ affected, skipped }`.
- **Ownership:** todas as queries filtram por `user_id: req.userId` primeiro (admins inclusive). Regra «personal is sacred», igual ao `curve_category_overrides`.
- **Integracao com stats:** `server/src/services/expenseStats.js :: computeDashboardStats` carrega o set de `expense_id`s excluidos em paralelo e filtra-os antes de calcular `month_total` + `weekly_expenses` (alimento do Savings Score).
- **Scope temporal:** global, nao por-ciclo. Excluir uma despesa hoje mantem-na excluida em qualquer ciclo futuro ate ser explicitamente «reincluida» via `DELETE`.
- **UI entry points:** action bar bulk em `/expenses` (§2.10) + mini-botao `CalendarOff` no header do `CategoryPickerPopover` (§2.10.1 — presente em `/expenses`, `/` e `/curve/logs`).
- **Auditoria:** cada toggle escreve `curve_logs` com `action: 'expense_excluded_from_cycle'` (POST) ou `'expense_included_in_cycle'` (DELETE). Single-row inclui `expense_id + entity`; bulk inclui so `detail = "count=<N>"`. Ver `docs/CURVE_LOGS.md` §4.

---

## Mapa de Relacoes entre Collections

```
┌──────────────┐
│    users     │
│  (Embers)    │
│              │
│  _id ◄───────┼──────────────────────────────────────┐
│  email       │                                       │
│  role        │                                       │
└──────────────┘                                       │
       ▲                                               │
       │ user_id                                       │ user_id
       │                                               │
┌──────┴───────┐    category_id    ┌──────────────┐    │
│   expenses   │──────────────────►│  categories  │    │
│  (Embers)    │                   │  (Embers)    │    │
│              │                   │              │    │
│  _id         │                   │  _id         │    │
│  entity      │                   │  name        │    │
│  amount      │                   │  entities[]  │    │
│  date        │                   └──────────────┘    │
│  card        │                                       │
│  digest (UQ) │◄──── expense_id ──┐                   │
│  user_id     │                   │                   │
│  category_id │                   │                   │
└──────────────┘                   │                   │
                                   │                   │
┌──────────────┐    config_id    ┌─┴────────────┐      │
│ curve_configs│◄────────────────│  curve_logs   │      │
│ (Standalone) │                 │ (Standalone)  │      │
│              │                 │               │      │
│  _id         │                 │  _id          │      │
│  user_id ────┼─────────────────┼──user_id──────┼──────┘
│  imap_*      │                 │  status       │
│  sync_*      │                 │  entity       │
│  maildir_*   │                 │  digest       │
│  last_sync_* │                 │  expense_id ──┘
└──────────────┘                 │  error_detail │
                                 └───────────────┘
```

---

## API do Standalone (Endpoints Necessarios)

### Expenses (opera sobre collection existente do Embers)

| Metodo | Rota | Descricao | Collection |
|--------|------|-----------|------------|
| POST | `/api/expenses` | Criar despesa (parsed do email) | expenses (INSERT) |
| GET | `/api/expenses` | Listar despesas do user (com filtros) | expenses (READ) |
| GET | `/api/expenses/:id` | Ver despesa individual | expenses (READ) |
| GET | `/api/expenses/monthly` | Totais mensais (12 meses, ciclo dia 22) | expenses (READ) |
| GET | `/api/expenses/savings-score` | Score semanal de poupanca | expenses (READ) |

### Categories (READ-ONLY sobre collection existente)

| Metodo | Rota | Descricao | Collection |
|--------|------|-----------|------------|
| GET | `/api/categories` | Listar todas as categorias | categories (READ) |
| GET | `/api/categories/:id` | Ver categoria | categories (READ) |

### Curve Config (collection propria)

| Metodo | Rota | Descricao | Collection |
|--------|------|-----------|------------|
| GET | `/api/curve/config` | Ver config IMAP do user | curve_configs (READ) |
| PUT | `/api/curve/config` | Actualizar config IMAP | curve_configs (UPDATE) |
| POST | `/api/curve/config` | Criar config inicial | curve_configs (INSERT) |
| DELETE | `/api/curve/config` | Remover config | curve_configs (DELETE) |

### Curve Sync (orquestracao)

| Metodo | Rota | Descricao | Collections |
|--------|------|-----------|-------------|
| POST | `/api/curve/sync` | Forcar sync manual (le emails, cria expenses) | expenses, curve_logs, curve_configs |
| GET | `/api/curve/status` | Estado do ultimo sync | curve_configs (READ) |
| POST | `/api/curve/test-connection` | Testar ligacao IMAP | nenhuma (so I/O externo) |

### Curve Logs (collection propria)

| Metodo | Rota | Descricao | Collection |
|--------|------|-----------|------------|
| GET | `/api/curve/logs` | Historico de emails processados | curve_logs (READ) |

### Autocomplete (READ sobre expenses existentes)

| Metodo | Rota | Descricao | Collection |
|--------|------|-----------|------------|
| GET | `/api/autocomplete/cards?term=` | Cartoes distintos | expenses (READ) |
| GET | `/api/autocomplete/entities?term=` | Entidades distintas | expenses (READ) |
| GET | `/api/autocomplete/categories?term=` | Nomes de categorias | categories (READ) |

### Health

| Metodo | Rota | Descricao |
|--------|------|-----------|
| GET | `/api/health` | Health check (DB + IMAP) |

---

## Regras de Consistencia com o Embers

### FAZER
- Usar `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }` em todos os schemas
- Usar `collection: 'nome_exacto'` para garantir que o Mongoose nao pluraliza
- Respeitar o campo `digest` como unique index — e o mecanismo de dedup partilhado
- Usar `user_id` e `category_id` como ObjectId (nao como String)
- Executar `assignCategory()` ao criar expense (replica o `before_create` do Mongoid)

### NAO FAZER
- Nunca adicionar campos novos nas collections `users`, `categories`, `expenses`
- Nunca fazer UPDATE ou DELETE em expenses existentes (so o Embers faz isso)
- Nunca alterar indexes existentes
- Nunca usar `mongoose.set('strictQuery', false)` — manter strict para evitar campos fantasma
