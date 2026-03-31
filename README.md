# Curve Sync Standalone - Reference Package

Este directorio contem todos os ficheiros de referencia necessarios para construir o servico standalone Curve Sync (Vite + Express + MongoDB), totalmente independente do Embers mas partilhando a mesma base de dados MongoDB.

## Estrutura

```
standalone-reference/
├── README.md                              # Este ficheiro
├── docs/
│   ├── MONGODB_SCHEMA.md                  # Schema MongoDB completo com Mongoose equivalents,
│   │                                      # mapa de relacoes, API endpoints, regras de consistencia
│   ├── expense-tracking.md                # Documentacao completa do sistema de despesas,
│   │                                      # cronjob, TODOs, arquitectura standalone
│   └── embers-reference/                  # Ficheiros originais do Embers (READ-ONLY reference)
│       ├── CLAUDE.md                      # Visao geral da plataforma Embers
│       ├── curve.py                       # Parser original (logica a portar para JS/cheerio)
│       ├── models/
│       │   ├── expense.rb                 # Schema Expense (Mongoid) — source of truth
│       │   ├── category.rb                # Schema Category (Mongoid) — entidades + icon
│       │   └── user.rb                    # Schema User (Mongoid) — auth + relacoes
│       ├── controllers/
│       │   ├── expenses_controller.rb     # Logica: add_expense, savings_score, monthly, autocomplete
│       │   └── categories_controller.rb   # CRUD categorias (referencia)
│       ├── frontend/
│       │   ├── services/
│       │   │   ├── expense.js             # API calls do frontend Embers (contract reference)
│       │   │   └── category.js            # API calls categorias
│       │   └── components/
│       │       ├── expenses/
│       │       │   ├── index.js           # Listagem: tabela, filtros, paginacao, savings score
│       │       │   ├── form.js            # Formulario: autocomplete, digest SHA-256, datepicker
│       │       │   └── show.js            # Vista detalhada de uma despesa
│       │       └── curve/
│       │           └── index.js           # Componente Curve actual (a redesenhar)
│       └── config/
│           ├── mongoid.yml_example        # DB names: embers_db (prod), embers_db_dev (dev)
│           └── routes.rb                  # Rotas Rails existentes (para nao colidir)
```

## Como Usar

1. **Ler `docs/MONGODB_SCHEMA.md`** primeiro — contem o schema completo, Mongoose equivalents, mapa de relacoes, e regras de consistencia
2. **Ler `docs/expense-tracking.md`** — documentacao detalhada do sistema, cronjob de producao, TODOs priorizados, e proposta de arquitectura standalone
3. **Consultar `docs/embers-reference/`** quando precisar de ver a implementacao original de qualquer funcionalidade

## Stack Alvo

| Camada | Tech |
|--------|------|
| Frontend | Vite + React |
| Backend | Express/Fastify (Node.js) |
| Database | MongoDB (mesma instancia do Embers) |
| ODM | Mongoose |
| Email parsing | cheerio (equivalente BeautifulSoup) |
| Filesystem read | fs/promises (ler Maildir) |
| Scheduler | node-cron |
| Hash/digest | crypto (nativo Node.js) |

## Collections MongoDB

| Collection | Owner | Acesso do Standalone |
|---|---|---|
| `users` | Embers | READ-ONLY |
| `categories` | Embers | READ-ONLY |
| `expenses` | Embers | READ + INSERT |
| `curve_configs` | **Standalone** | CRUD completo |
| `curve_logs` | **Standalone** | INSERT + READ |
