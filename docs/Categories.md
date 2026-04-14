# Categories — Design & Implementation

> **Estado:** esqueleto. Cada capítulo abaixo é um placeholder com um resumo
> do que vai ser coberto. Vamos expandir capítulo a capítulo.

---

## 1. Contexto e objectivos

### 1.1 Porquê este documento

A catalogação automática é a peça que transforma um stream de emails
do Curve Card numa leitura útil das finanças pessoais. No pipeline
actual essa transformação é feita por uma única linha de código em
Embers:

```ruby
# docs/embers-reference/models/expense.rb:130-132
def assign_category
  self.category = Category.where(:entities.in => [entity]).first ||
                  Category.find_or_create_by(name: 'General')
end
```

Curve Sync herdou o mesmo contrato — `categories` é uma colecção
partilhada e a lógica de atribuição foi portada para JavaScript
(`server/src/services/expense.js:40-49`) com apenas uma melhoria: o
match passou de exacto para substring case-insensitive. O resto do
comportamento (sem overrides, sem UI, sem retroactividade) continua
igual. Este documento define como se substitui esse contrato por algo
que justifique o nome "auto-catalogação".

### 1.2 O problema

O estudo do código actual — `assign_category` em Embers e
`assignCategoryFromList` em Curve Sync — revela sete falhas concretas
que cada utilizador sente no dia-a-dia:

1. **Match frágil em Embers.** `Category.where(:entities.in =>
   [entity])` exige igualdade exacta de strings. O Curve Card entrega
   entidades como `"LIDL CASCAIS PT"`, `"MCDONALDS*PICOAS"` ou
   `"MB WAY - BAKERY 123"` — nenhuma casa com `"Lidl"`, `"McDonalds"`
   ou `"Bakery"` no array global. O resultado cai sempre em `"General"`
   e a categoria morre.

2. **Substring ingénuo em Curve Sync.** A port para JavaScript usa
   `lower.includes(e.toLowerCase())`, o que resolve casos tipo "Lidl
   Cascais" mas introduz falsos positivos: um entry curto como `"co"`
   passa a casar tanto `"coffee"` como `"costa"` como `"continente"`.
   A ordem em que as categorias são lidas passa a determinar o
   vencedor — um bug silencioso.

3. **Sem normalização.** Acentos, espaços a mais, sufixos "PT",
   dígitos e asteriscos residuais dos POS não são removidos antes da
   comparação. `"Café"` e `"Cafe"` são entidades distintas para o
   matcher.

4. **Zero personalização.** O catálogo é global. Se dois users do
   mesmo Embers quiserem categorizar "Lidl" de formas diferentes (um
   como Supermercado, outro como Café porque só lá compra café), é
   impossível — a última edição do admin sobrepõe-se a todos.

5. **CRUD vive noutra app.** `/api/categories` em Curve Sync é
   read-only (`server/src/routes/categories.js`). Para adicionar uma
   entidade a uma categoria, o utilizador tem de sair para o painel
   admin do Embers (Rails `/admin/categories`). Isto parte o ciclo
   "vejo uma despesa mal catalogada → corrijo → as próximas ficam bem"
   dentro de Curve Sync.

6. **Ecrãs dispersos.** O total gasto por categoria existe
   conceptualmente (`Category#total_spent` em Embers), mas não há um
   sítio em Curve Sync onde o utilizador veja ao mesmo tempo **a
   categoria, o total do mês e as entidades que a alimentam**. A
   página de Despesas mostra só o `category_name` como badge; o
   Dashboard agrega mas não edita.

7. **Correcções não se propagam.** Se o utilizador trocar manualmente
   a categoria de uma despesa, essa decisão não vira regra: a próxima
   despesa da mesma entidade volta a ser mal catalogada. Não há
   "aplicar a todas as despesas passadas com esta entidade" nem
   aprendizagem automática.

### 1.3 Objectivos

O sistema redesenhado tem de cumprir, por ordem de prioridade:

1. **Dois níveis de privilégio** — admins definem um catálogo global
   (`Lidl → Supermercado` vale para todos) e cada user pode sobrepor
   esse catálogo com regras pessoais (`Lidl → Café` só para mim). A
   resolução é sempre `override do user > catálogo global > sem
   categoria`.

2. **CRUD completo em Curve Sync.** O user vive dentro da app: criar,
   editar e apagar categorias (admin), adicionar e remover entidades
   do catálogo (admin) e gerir os seus overrides (user). O painel
   admin do Embers deixa de ser um requisito operacional.

3. **Matching robusto.** Normalização prévia (lowercase, sem
   diacríticos, espaços colapsados, sufixos de localização removidos),
   tipos de match explícitos (`exact`, `starts_with`, `contains`) e
   desempate por especificidade (longest-match-wins) em vez de ordem
   de leitura do Mongo.

4. **Ecrã único.** Uma rota — provisoriamente `/categories` — que
   combina CRUD, total mensal por categoria (alinhado ao ciclo do dia
   22, como o resto do sistema) e o catálogo de entidades. Tem de
   aguentar categorias com dezenas ou centenas de entidades sem
   colapsar na UX.

5. **Re-catalogação retroactiva opt-in.** Todo o fluxo que altera
   regras (editar entidades globais, criar um override) oferece um
   botão **"aplicar a despesas passadas"**, com modal de confirmação
   que mostra o número de despesas afectadas antes do commit. O
   default permanece "só afecta despesas futuras".

6. **Compatibilidade preservada com Embers.** O schema da colecção
   `categories` não muda — Embers continua a ler e escrever `name` e
   `entities[]` como hoje. Toda a extensão (overrides, match_type,
   prioridades) vive em colecções novas pertencentes a Curve Sync. O
   `before_create :assign_category` do Embers não precisa de saber da
   existência dos overrides para continuar a funcionar.

7. **Auditoria completa.** Cada escrita (add/remove entidade, criar
   override, apply-to-all) gera uma entrada em `curve_logs` com
   contexto suficiente para reverter — quem fez, que regra, quantas
   despesas foram tocadas.

### 1.4 Fora do escopo

Para manter a ambição do MVP realista, estas ideias ficam
explicitamente de fora:

- **Machine learning / NLP.** Nada de tokenização, embeddings ou
  classificadores. A normalização + match literal por camadas cobre
  mais de 95% dos casos reais a um custo de desenvolvimento e
  manutenção ordens de grandeza menor.
- **Fuzzy matching (Levenshtein, trigramas).** Rejeitado pelo mesmo
  motivo: complexidade vs retorno. Pode entrar numa fase posterior
  se a telemetria mostrar que vale a pena.
- **Aprendizagem a partir de correcções manuais.** A UX de
  "quando o user muda a categoria de uma despesa, oferecer adicionar
  a entidade ao override" é valiosa mas vive na fase 2 — este doc
  trata só da infra que a suporta.
- **Hierarquia de categorias (sub-categorias, tags).** Não está no
  pedido e obrigava a refactorizar o schema partilhado.
- **Qualquer alteração ao schema de `categories` em Embers.** Proibido
  por regra em `CLAUDE.md` §MongoDB Collection Access Rules.

### 1.5 Princípios orientadores

- **Embers é canónico onde o schema é partilhado.** Escrevemos em
  `categories` e `expenses` só dentro dos contratos existentes;
  tudo o resto vai para colecções novas.
- **Transparência.** O user tem de perceber sempre _porquê_ uma
  despesa foi atribuída a uma categoria — qual regra (global ou
  override), qual match, qual pattern. Sem isso, confiar na
  automação fica difícil.
- **Reversibilidade.** Qualquer acção destrutiva (delete de regra,
  apply-to-all) tem de ser auditada e, idealmente, anulável.
- **Reutilização UIX.** O novo ecrã usa tokens, componentes e padrões
  já definidos em `docs/UIX_DESIGN.md` (paleta sand/curve, `card`,
  `input`, badges, master-detail). Não introduz novos primitivos.
- **Simplicidade > elegância teórica.** Resolvemos 95% dos casos com
  regras explícitas bem desenhadas antes de considerar qualquer
  heurística estatística.

## 2. Estado actual e limitações

O capítulo 1 apresentou as falhas em forma de problema; este
capítulo faz o inventário técnico de _onde_ essas falhas vivem. A
ideia é que qualquer pessoa a tocar neste código encontre todos os
pontos de contacto sem ter que re-pesquisar a base. Cada sub-secção
termina com uma nota sobre o que se mantém ou substitui na
redesenhada.

### 2.1 Colecção `categories` — schema partilhado

O schema canónico vive em Embers e é respeitado por Curve Sync sem
desvios:

```ruby
# docs/embers-reference/models/category.rb
class Category < ApplicationRecord
  field :name,     type: String
  field :entities, type: Array, default: []

  validates :name, presence: true, uniqueness: true
  has_many :expenses
  has_mongoid_attached_file :icon  # Paperclip, ficheiro no filesystem
end
```

Do lado Curve Sync a port para Mongoose é mínima e deliberadamente
alinhada:

```javascript
// server/src/models/Category.js
const categorySchema = new mongoose.Schema(
  {
    name:     { type: String, required: true, unique: true },
    entities: [{ type: String }],
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'categories',
  },
);
```

**Campos que o schema oferece:** `name`, `entities[]`, `icon` (só
Embers), timestamps. **Campos que não oferece e que o redesign NÃO
pode adicionar** (regra em `CLAUDE.md` §MongoDB Collection Access
Rules): match type, prioridade, cor, flag global vs user, padrão
regex, user_id. Toda a riqueza extra tem de viver numa colecção
nova, sem tocar neste schema.

### 2.2 Pipeline de atribuição

Há dois pontos de entrada por onde uma despesa ganha `category_id`:

**Criação manual via API** — `server/src/routes/expenses.js:45-69`
chama `assignCategory(entity)` antes do `Expense.create`. Cada
despesa dispara um `Category.find().lean()` próprio:

```javascript
// server/src/services/expense.js:23-27
export async function assignCategory(entity) {
  if (!entity) return null;
  const categories = await Category.find().lean();
  return assignCategoryFromList(entity, categories);
}
```

**Sincronização automática via orchestrator** — carrega o catálogo
uma vez por run e reutiliza-o para todos os emails:

```javascript
// server/src/services/syncOrchestrator.js:255-262
let categoriesCache = [];
try {
  categoriesCache = await Category.find().lean();
} catch (e) {
  console.warn(`syncEmails: could not load categories: ${e.message}`);
}

// ...e depois, dentro do loop (linha 334):
const category_id = assignCategoryFromList(parsed.entity, categoriesCache);
```

Os dois caminhos convergem para a mesma função pura, que é onde vive
a lógica de match em Curve Sync:

```javascript
// server/src/services/expense.js:40-49
export function assignCategoryFromList(entity, categories) {
  if (!entity) return null;
  const lower = entity.toLowerCase();
  for (const cat of categories) {
    if (cat.entities?.some((e) => lower.includes(e.toLowerCase()))) {
      return cat._id;
    }
  }
  return null;
}
```

**Comportamento observado:**

- Itera as categorias pela ordem em que o Mongo as devolveu (sem
  `sort`, sem índice útil).
- Para cada categoria, testa se algum entry do array `entities` é
  **substring case-insensitive** do nome da despesa.
- A primeira categoria que case vence. Empates silenciosos.
- Devolve `null` se nada casar — o fallback para `"General"` de
  Embers **não foi portado**. Em Curve Sync, uma despesa não-casada
  fica simplesmente sem categoria.

Do lado Embers a função equivalente é mais simples e mais estrita:

```ruby
# docs/embers-reference/models/expense.rb:130-132
def assign_category
  self.category = Category.where(:entities.in => [entity]).first ||
                  Category.find_or_create_by(name: 'General')
end
```

`$in` compara strings inteiras — "LIDL CASCAIS PT" não casa com
"Lidl". O fallback garante que a despesa nunca fica sem
`category_id`, mas ao custo de encher a categoria "General" com tudo
o que o matcher não percebe.

**No redesenhado isto muda:** a função de resolução passa a receber
não só `categories` (catálogo global) mas também `userOverrides`
(catálogo pessoal), normaliza a entidade antes de comparar, respeita
o `match_type` registado em cada regra, e desempata por
longest-match. Ver capítulo 5.

### 2.3 Colecção `expenses` — imutabilidade actual

```javascript
// server/src/models/Expense.js
const expenseSchema = new mongoose.Schema({
  entity:      { type: String, required: true },
  amount:      { type: Number, required: true },
  date:        { type: String, required: true },
  card:        { type: String },
  digest:      { type: String, required: true },
  user_id:     { type: ObjectId, ref: 'User', required: true },
  category_id: { type: ObjectId, ref: 'Category' },
});

expenseSchema.index({ digest: 1, user_id: 1 }, { unique: true });
```

`CLAUDE.md` é explícito: `expenses` é **READ + INSERT only** — nunca
UPDATE nem DELETE. A auto-categorização corre uma vez no insert e a
decisão fica congelada: se uma regra nova passa a cobrir a entidade,
as despesas antigas ficam na categoria errada para sempre. Este
contrato é precisamente o que trava a feature "apply to all" e vai
ter que ser relaxado (capítulo 4, §4.3) para permitir UPDATE apenas
de `category_id`.

### 2.4 API actual de categorias em Curve Sync

Um único endpoint, read-only:

```javascript
// server/src/routes/categories.js
router.get('/', async (_req, res) => {
  const data = await Category.find().sort('name').lean();
  res.json({ data });
});
```

Comparado com o que Embers expõe:

| Acção | Embers (`/admin/categories`) | Curve Sync (`/api/categories`) |
|-------|------------------------------|--------------------------------|
| List | ✓ (admin) | ✓ (qualquer user autenticado) |
| Show | ✓ | ✗ |
| Create | ✓ | ✗ |
| Update (incluindo `entities[]`) | ✓ | ✗ |
| Delete | ✓ | ✗ |

Embers trata `entities` como parâmetro de massa (PUT com o array
inteiro, `category_params.permit(:name, :icon, entities: [])` em
`categories_controller.rb:30-33`). Não há endpoint granular para
adicionar/remover uma única entidade — quem edita, lê o array
inteiro, modifica-o em JS e envia tudo de volta. É uma operação
pesada que funciona porque o catálogo, para já, é pequeno.

**No redesenhado isto muda:** `/api/categories` ganha POST/PUT/DELETE
restritos a admins, e surge um endpoint granular para mutação de
entidades (evita PUT da categoria inteira quando o catálogo cresce).
`/api/category-overrides` novo cobre o lado user. Detalhes no
capítulo 8.

### 2.5 UI actual — dispersão

Dentro de Curve Sync existem dois pontos onde a categoria aparece,
nenhum editável:

- **Dashboard** (`DashboardPage.jsx`) — agrega totais por período
  mas não por categoria.
- **Despesas** (`ExpensesPage.jsx:100-108`) — mostra
  `exp.category_name` como badge neutro (`bg-sand-100 text-sand-600`)
  ao lado do montante. Sem click, sem filtro, sem edição.

O user que queira alterar a categoria de uma despesa ou o catálogo
global tem de:

1. Abrir o painel admin de Embers (Rails).
2. Editar `entities[]` da categoria.
3. Esperar pelo próximo sync — e aí descobrir que a mudança só
   afecta despesas futuras (porque `expenses` é INSERT-only).

O gap entre o local onde o problema é visível (página de Despesas
em Curve Sync) e o local onde o problema é resolvido (admin do
Embers, noutra URL, noutra aplicação) é o atrito principal que o
novo ecrã de categorias (capítulo 9) vai eliminar.

### 2.6 Tabela-resumo — o que cada camada entrega hoje

| Camada | Embers | Curve Sync |
|--------|--------|------------|
| Schema `categories` | `name`, `entities[]`, `icon` | Igual (port directo) |
| Algoritmo de match | `$in` exacto | `includes()` case-insensitive |
| Normalização | nenhuma | nenhuma |
| Fallback "General" | sim, auto-create | não (devolve `null`) |
| Overrides per-user | ✗ | ✗ |
| CRUD de categorias | ✓ (admin panel Rails) | ✗ (só GET) |
| Edição granular de `entities[]` | ✗ (PUT pesado) | ✗ |
| Retroactividade (`expenses.UPDATE`) | ✓ (Rails pode) | ✗ (regra INSERT-only) |
| Total por categoria | `Category#total_spent` (modelo) | não exposto em API |
| Ecrã único de gestão | ✗ (spread por vários admin screens) | ✗ |
| Auditoria de mudanças | Rails logger genérico | `curve_logs` existe mas não é usado para categorias |

Cada linha marcada com ✗ na coluna Curve Sync é um item de trabalho
coberto pelos capítulos 3 a 11.

## 3. Arquitectura de dois níveis (conceptual)

_Placeholder._ Apresenta o modelo mental antes do schema:

- **Nível admin (global):** um admin define o catálogo base de entidades
  por categoria, aplicado a todos os utilizadores. Ex.: Lidl →
  Supermercado.
- **Nível user (override):** cada utilizador pode sobrepor uma entidade
  ao seu catálogo pessoal (Lidl → Coffee apenas para mim).
- **Ordem de resolução:** override do user > catálogo global > sem
  categoria.
- **Retroactividade opcional:** qualquer edição (admin ou user) oferece
  um botão "aplicar a despesas passadas" que vai reprocessar
  `category_id` do escopo correspondente.

## 4. Modelo de dados

_Placeholder._ Define exactamente o que muda no MongoDB:

- `categories` (existente, partilhado com Embers): continua com o
  schema canónico (`name`, `entities[]`, `icon`, timestamps). Curve Sync
  passa a ter CRUD mas não pode adicionar campos novos — extensões vão
  para colecções próprias.
- **Nova colecção** `curve_category_overrides` (owned por Curve Sync):
  `{ user_id, pattern, match_type, category_id, created_at, updated_at }`
  com índice composto único por `(user_id, pattern_normalized)`.
- **Ajuste** a `expenses`: passa a permitir UPDATE apenas do campo
  `category_id` para suportar "apply to all". Todos os outros campos
  continuam imutáveis (entity, amount, date, card, digest, user_id).
- Notas sobre compatibilidade com Mongoid (snake_case timestamps,
  collection name explícito, ObjectId em vez de String).

## 5. Algoritmo de matching

_Placeholder._ Descreve o novo pipeline de auto-categorização:

- **Normalização** do texto da entidade (lowercase, strip diacríticos,
  colapsar espaços, remover sufixos de localização tipo "LISBOA PT",
  descartar asteriscos/dígitos residuais dos POS).
- **Resolução em camadas:** overrides do user primeiro, catálogo global
  depois.
- **Desempate por especificidade:** longest-match-wins + tie-break por
  prioridade do `match_type` (`exact` > `starts_with` > `contains`).
- **Tipos de match suportados** (só em overrides; o catálogo global
  mantém-se substring para compatibilidade com Embers).
- Pseudo-código e exemplos concretos (Lidl, McDonalds, MB WAY, etc.).

## 6. Re-catalogação retroactiva ("apply to all")

_Placeholder._ Define a semântica e o fluxo do botão:

- **Quando aparece:** ao editar entidades de uma categoria (admin) ou
  ao criar/editar um override (user).
- **Escopo:**
  - admin → todas as despesas de todos os users que ainda não têm
    override pessoal para aquela entidade;
  - user → todas as próprias despesas que casem com o override.
- **Implementação:** query bulk `Expense.updateMany({...}, { $set:
  { category_id } })` com logging em `curve_logs`.
- **Auditoria:** cada reassign gera uma entrada para rastreabilidade.
- **Consistência:** a flag precisa de ser opcional — o user pode querer
  a mudança só para despesas futuras.

## 7. Autorização e papéis

_Placeholder._ Mapeia capacidades por endpoint:

| Acção | User | Admin |
|-------|------|-------|
| Ler categorias | ✓ | ✓ |
| Criar / editar / apagar categoria | ✗ | ✓ |
| Editar `Category.entities[]` (global) | ✗ | ✓ |
| Criar / editar / apagar override pessoal | ✓ (só os seus) | ✓ (só os seus) |
| "Apply to all" no catálogo global | ✗ | ✓ |
| "Apply to all" num override pessoal | ✓ (só nas suas despesas) | ✓ (só nas suas despesas) |

Explica o middleware `requireAdmin` que será adicionado (lê `role` da
colecção `users` — já existe a enum admin/user).

## 8. API

_Placeholder._ Lista completa de endpoints novos/alterados, com shape
de request/response, códigos de erro e rate-limiting relevante:

- `GET/POST/PUT/DELETE /api/categories[/:id]` — CRUD admin-only (exceto
  GET que fica aberto).
- `POST/DELETE /api/categories/:id/entities` — gestão granular de
  entidades globais (evita PUT pesado na categoria inteira).
- `GET/POST/PUT/DELETE /api/category-overrides[/:id]` — CRUD dos
  overrides pessoais do user autenticado.
- `POST /api/categories/:id/apply-to-all` e
  `POST /api/category-overrides/:id/apply-to-all` — endpoints
  dedicados à re-catalogação retroactiva.
- `GET /api/categories/stats` — totais mensais por categoria, alinhados
  ao ciclo do dia 22.

## 9. UIX — ecrã único de gestão de categorias

_Placeholder._ Desenho da nova rota `/categories` (ou similar). Pontos-
chave a cobrir:

- **Layout master-detail** (lista à esquerda, detalhe à direita) para
  caber CRUD + total por categoria + catálogo de entidades.
- **Coluna esquerda:** lista de categorias com swatch de cor, nome,
  total mensal (€), contadores de entidades/despesas, ordenável.
- **Coluna direita:** header editável, strip de KPIs (total mês,
  nº despesas, nº entidades), tabs internas para Entidades, Despesas
  recentes e (opcional) Tendência mensal.
- **Catálogo de entidades:** input inline para adicionar, lista
  pesquisável (alguns catálogos vão ser grandes — virtualização ou
  paginação simples), badge global vs override, bulk-select para mover
  entre categorias.
- **Botão "Apply to all":** aparece após edição, com modal de
  confirmação que mostra quantas despesas vão ser afectadas.
- **Modo admin vs modo user:** o mesmo ecrã adapta-se ao `role` —
  admins editam o catálogo global, users só adicionam/removem
  overrides pessoais (a lista global aparece read-only com badge).
- **Responsividade:** colapsar para uma coluna com back nav em mobile
  (consistente com o roadmap da sidebar em UIX_DESIGN.md §12).
- **Paleta e componentes:** reutilizar tokens sand/curve, `card`,
  `input`, `btn-primary/secondary`, badges conforme §2-5 do
  UIX_DESIGN.md.

## 10. Integração com o sync orchestrator

_Placeholder._ Como o novo sistema encaixa no pipeline existente:

- Carregar overrides do user (actual `user_id` do config) no arranque
  do sync, à semelhança do `categoriesCache` já existente.
- Nova função `resolveCategory(entity, { overrides, globalCategories })`
  substitui `assignCategoryFromList`.
- Impacto em performance: duas `find()` por sync em vez de uma (ainda
  O(1) por sync, não N+1).
- Compatibilidade: se não houver overrides, comporta-se exactamente
  como hoje.

## 11. Compatibilidade com Embers e plano de faseamento

_Placeholder._ Garantias e ordem de rollout:

- **Embers continua a funcionar:** `Category.entities[]` não muda de
  schema; overrides ficam numa colecção à parte que o Embers ignora.
- **Expenses:** a relaxação do UPDATE cobre só `category_id`; o
  `before_create :assign_category` do Embers continua a correr para
  novas despesas criadas do lado Embers.
- **Faseamento sugerido:**
  1. Backend — schema dos overrides + CRUD admin + matching novo.
  2. Sync orchestrator — consumir overrides.
  3. Frontend — ecrã master-detail (modo user primeiro, admin depois).
  4. "Apply to all" — endpoint + modal de confirmação.
  5. Migração de dados — nenhuma obrigatória; opcionalmente seed de
     entidades comuns no catálogo global.
- **Riscos e mitigação:** race-conditions entre admin add + user
  override, atomicidade do bulk update, auditoria em `curve_logs`,
  rollback plan.
