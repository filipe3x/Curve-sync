# Curve Sync

Serviço standalone para importação automática de despesas a partir de emails do Curve Card. Frontend em Vite + React + Tailwind, backend em Express + Mongoose, partilhando a mesma instância MongoDB do Embers.

## Pré-requisitos

- **Node.js** >= 18
- **npm** >= 9
- **MongoDB** >= 5.0 (a mesma instância usada pelo Embers)

## Instalação

```bash
# 1. Clonar o repositório
git clone https://github.com/filipe3x/Curve-sync.git
cd Curve-sync

# 2. Instalar todas as dependências (root + client + server)
npm run install:all

# 3. Configurar variáveis de ambiente do servidor
cp server/.env.example server/.env
```

Editar `server/.env` com os valores correctos:

```env
PORT=3001
MONGODB_URI=mongodb://localhost:27017/embers_db
NODE_ENV=development
```

> **Nota:** A `MONGODB_URI` deve apontar para a mesma base de dados do Embers (`embers_db` em produção, `embers_db_dev` em desenvolvimento). Ver `docs/embers-reference/config/mongoid.yml_example` para os nomes exactos.

## Executar

```bash
# Desenvolvimento — arranca client (Vite :5173) e server (Express :3001) em paralelo
npm run dev

# Apenas o frontend
npm run dev:client

# Apenas o backend
npm run dev:server
```

O Vite faz proxy automático de `/api/*` para `http://localhost:3001`, por isso em desenvolvimento basta abrir `http://localhost:5173`.

## Build de produção

```bash
# Compilar o frontend (output em client/dist/)
npm run build

# Arrancar o servidor (serve a API, o frontend estático deve ser servido à parte ou via reverse proxy)
npm run start
```

## Estrutura do Projecto

```
Curve-sync/
├── client/                     # Frontend — Vite + React + Tailwind
│   ├── src/
│   │   ├── components/
│   │   │   ├── layout/         # Shell, Sidebar, Icons
│   │   │   └── common/         # PageHeader, StatCard, EmptyState
│   │   ├── pages/              # Dashboard, Expenses, CurveConfig, CurveLogs
│   │   └── services/api.js     # Todas as chamadas HTTP ao backend
│   ├── tailwind.config.js      # Paletas custom (curve, sand)
│   └── vite.config.js          # Proxy /api → :3001
│
├── server/                     # Backend — Express + Mongoose
│   ├── src/
│   │   ├── config/db.js        # Ligação MongoDB
│   │   ├── models/             # Expense, Category, User (RO), CurveConfig, CurveLog
│   │   ├── routes/             # expenses, categories, curve, autocomplete
│   │   └── services/           # expense.js (digest SHA-256, auto-category)
│   └── .env.example
│
├── docs/                       # Documentação e referências
│   ├── MONGODB_SCHEMA.md       # Schema completo com regras de consistência
│   ├── expense-tracking.md     # Documentação do sistema de despesas
│   └── embers-reference/       # Ficheiros originais do Embers (READ-ONLY)
│
├── CLAUDE.md                   # Instruções para o Claude Code
├── ROADMAP.md                  # TODOs e plano de evolução
└── package.json                # Scripts raiz (dev, build, install:all)
```

## Acesso à Base de Dados

Este serviço partilha o MongoDB com o Embers. As regras de acesso são rigorosas:

| Collection      | Dono          | Acesso do Curve Sync       |
|-----------------|---------------|----------------------------|
| `users`         | Embers        | READ-ONLY                  |
| `categories`    | Embers        | READ-ONLY                  |
| `expenses`      | Embers        | READ + INSERT (nunca UPDATE/DELETE) |
| `curve_configs` | **Curve Sync** | CRUD completo              |
| `curve_logs`    | **Curve Sync** | INSERT + READ (TTL 90 dias)|

## API

| Método | Rota                        | Descrição                          |
|--------|-----------------------------|------------------------------------|
| GET    | `/api/expenses`             | Listar despesas (filtros, paginação) |
| POST   | `/api/expenses`             | Criar despesa                      |
| GET    | `/api/categories`           | Listar categorias (read-only)      |
| GET    | `/api/curve/config`         | Ver configuração IMAP              |
| PUT    | `/api/curve/config`         | Actualizar configuração IMAP       |
| POST   | `/api/curve/sync`           | Forçar sincronização manual        |
| POST   | `/api/curve/test-connection`| Testar ligação IMAP                |
| GET    | `/api/curve/logs`           | Histórico de processamento         |
| GET    | `/api/autocomplete/:field`  | Valores distintos (entity, card)   |
| GET    | `/api/display/summary`      | Snapshot para ecrãs externos (e-ink) |
| GET    | `/api/health`               | Health check                       |

### `/api/display/summary` — ecrãs externos (e-ink, smart mirrors)

Endpoint compacto pensado para **dispositivos externos** que mostram um resumo do ciclo actual à distância: um e-ink na secretária, um smart mirror, uma panel de home-automation. Devolve os quatro valores que um ecrã glance-able normalmente quer:

- **Mês e ano do ciclo actual** — em pt-PT, rotulado pelo mês de **fim** do ciclo (22 Mar → 21 Abr = «Abril 2026»)
- **Gasto no ciclo até agora** (EUR)
- **Orçamento** — `weekly` e `monthly` (ver `docs/expense-tracking.md` → «Linha de orçamento…» para o cálculo `weekly × 30,4375 / 7`)
- **Savings score** actual (0–10, 1 casa decimal)

#### Autenticação

Usa o mesmo fluxo de Bearer token que o frontend web — ver [`docs/AUTH.md`](docs/AUTH.md). O dispositivo faz login uma vez, guarda o token, e envia-o como header em cada pedido. A sessão **dura 24 h** — um e-ink a fazer poll de hora a hora deve estar preparado para re-autenticar 1× por dia; a lógica cabe em ~20 linhas na firmware (login → guardar token + `expires_at` → se o próximo pedido devolver 401, repetir login).

#### Exemplo de uso

```bash
# 1. Login — guarda o token
curl -s -X POST https://curve.example.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"…"}'
# → { "token": "abc123…", "user": { "id": "…", "email": "me@example.com" } }

# 2. Snapshot — usa o token em cada pedido
curl -s https://curve.example.com/api/display/summary \
  -H 'Authorization: Bearer abc123…'
# → {
#     "cycle": {
#       "month_label": "Abril 2026",
#       "month": "Abril",
#       "year": 2026,
#       "start": "2026-03-22",
#       "end":   "2026-04-21"
#     },
#     "spent": 123.45,
#     "budget": { "weekly": 73.75, "monthly": 321.00 },
#     "savings_score": 8.1,
#     "currency": "EUR",
#     "generated_at": "2026-04-19T14:32:10.123Z"
#   }
```

#### Notas para firmware de dispositivos

- **Frequência de poll:** não há rate-limit dedicado — o endpoint cai dentro do limiter global (100 pedidos/min por IP). Para um e-ink, `60 min` entre refreshes é mais que suficiente e mantém folga para os outros clientes que partilhem o IP.
- **Formato dos valores:** `spent` e os valores de `budget` vêm arredondados a 2 casas decimais; `savings_score` a 1. Zero necessidade de formatação adicional no device.
- **Fuso horário:** todas as datas são UTC. Converter localmente se o ecrã precisar de mostrar `start`/`end` em fuso local — mas o `month_label` já chega no formato user-facing que a maior parte das firmwares mostra tal e qual.
- **Erro de autenticação:** se o token expirar, o servidor devolve `401 { "error": "Token inválido ou expirado" }`. Re-login com as credenciais guardadas e retry.

## Design

Interface inspirada no Curve.com — sóbria, monocromática, com cantos arredondados e animações subtis de fade. Paleta de cores:

- **`curve`** — tons de vermelho escuro/castanho (#a03d27 → #3b160f)
- **`sand`** — cinzentos quentes (#faf9f7 → #2f2a24)

## Migrações one-shot

### Expense `date_at` (ROADMAP §2.x — Opção C)

Desde o PR [`claude/improve-expense-date-display-YFA21`] a listagem de `/expenses`, a dashboard «Despesas recentes» e o painel de detalhe em `/categories` sortam por `-date_at` — um campo `Date` tipado que vive lado-a-lado com o legacy `date: String`. Antes, o default era `-date` e estava quebrado: sort lexical sobre strings day-first («06 April 2026 08:53:31») + BSON type order (`String < Date`) em campos mixed-type colocavam rows antigas no topo e recentes no fundo da lista. Ver `server/scripts/analyze-expense-dates.js` para o diagnóstico completo.

⚠️ **Sequência importante para o deploy:** esta migração tem os steps 1-5 empilhados. **Só se merge o step 5 para prod depois de correr o backfill lá também.** Se o flip aterrar em prod antes do backfill, rows sem `date_at` caem para o fundo da lista (null sort descendente) — visível, não é data loss, mas degradação visível da UX até o backfill correr.

Runbook canónico:

1. **Deploy dos steps 1-4** (schema + INSERT path + script). Novos inserts já gravam `date_at`, nenhum query lê esse campo ainda. Zero impacto para o utilizador.
2. **Correr o backfill em prod:**
   ```bash
   node server/scripts/analyze-expense-dates.js              # audit
   node server/scripts/analyze-expense-dates.js --write      # plano
   node server/scripts/analyze-expense-dates.js --write --yes # execução
   node server/scripts/analyze-expense-dates.js --write      # idempotência
   ```
   Antes de avançar, confirmar no último comando: `rows to populate this run: 0` e `rows unparseable: 0`.
3. **Deploy do step 5** (flip do sort default para `-date_at`). Listagens passam a ficar correctas.

Se o step 5 já aterrou sem o backfill ter corrido, a recuperação é correr o backfill o quanto antes — não há data loss, os rows só ficam temporariamente sortados no fim.

## Deploy para produção (VPS Ubuntu)

Deploy automatizado via `scripts/deploy-prod.sh`. Cobre as seis fases do ROADMAP §3.9 (preflight → gate → pull+build → migrations → restart → rollback) e usa **PM2** (ou systemd, configurável) para gerir o processo no VPS.

```bash
# 1. Configurar (uma vez)
cp scripts/deploy.config.sh scripts/deploy.config.local.sh
$EDITOR scripts/deploy.config.local.sh    # VPS_HOST, VPS_USER, BACKEND_PORT, ...

# 2. Deploy
./scripts/deploy-prod.sh                  # interactive
./scripts/deploy-prod.sh --yes            # CI / non-interactive
./scripts/deploy-prod.sh --ref=<sha>      # specific commit
./scripts/deploy-prod.sh --dry-run        # preflight only
./scripts/deploy-prod.sh --rollback       # revert to previous backup
```

⚠️ **Migrações com sequência crítica** (ex. backfill `date_at`) ficam em [`docs/DEPLOY_NOTES.md`](docs/DEPLOY_NOTES.md). O preflight imprime cada bloco `## release:` antes da gate — ler antes de continuar.

⚠️ **Porta**: o VPS partilhado já corre `sleep-routine` em :3001. O default em `deploy.config.sh` é `:3002` para evitar colisão; manter alinhado com `server/.env` no servidor.

### Raspberry Pi (dev / staging)

O projecto funciona num Raspberry Pi 5 (ARM64) com Node.js >= 18 e MongoDB >= 5.0. Existem scripts de verificação na pasta `scripts/`:

```bash
# Verificar se tudo está instalado e que versões correm (não instala nada)
./scripts/setup-pi.sh

# Verificar se MongoDB (e opcionalmente Embers Rails) estão a correr
./scripts/check-services.sh
./scripts/check-services.sh --with-embers

# Verificar serviços + lançar dev (MongoDB tem de estar a correr)
./scripts/dev.sh
./scripts/dev.sh --with-embers      # também verifica Embers Rails
./scripts/dev.sh --server-only      # só backend
./scripts/dev.sh --client-only      # só frontend
```

### Pré-requisitos no Pi

1. **Node.js 20 LTS** — `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs`
2. **MongoDB 7.0** — [Instruções ARM64](https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-debian/)
3. **Ruby + Rails** (opcional) — Só necessário se executares o Embers localmente

### Embers Rails (opcional)

Se quiseres correr o Embers Rails ao lado do Curve Sync:

```bash
cd /path/to/embers
cp config/mongoid.yml_example config/mongoid.yml
cp config/application.yml_example config/application.yml
bundle install
bundle exec rails server -p 3000
```

O `check-services.sh --with-embers` procura o Embers em `../embers`, `../Embers`, `~/embers`, ou `~/Embers`. Para um caminho diferente, usa `EMBERS_PATH=/custom/path ./scripts/check-services.sh --with-embers`.

## Documentação adicional

- [`docs/MONGODB_SCHEMA.md`](docs/MONGODB_SCHEMA.md) — Schema MongoDB completo
- [`docs/expense-tracking.md`](docs/expense-tracking.md) — Sistema de despesas, savings score, ciclo mensal
- [`ROADMAP.md`](ROADMAP.md) — Plano de evolução e TODOs
