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

Este capítulo descreve só o **modelo mental** — quem decide o quê,
como decisões diferentes convivem, o que acontece quando há conflito.
O _schema_ que materializa esta ideia em MongoDB vive no capítulo 4; o
algoritmo concreto de matching vive no capítulo 5; a API que a expõe
vive no capítulo 8. Aqui ficamos ao nível dos conceitos.

### 3.1 Os dois níveis

O sistema tem exactamente **duas camadas** sobrepostas de regras de
catalogação. Qualquer despesa importada do Curve Card passa por ambas,
por esta ordem:

1. **Nível global (admin).** O admin da plataforma — o mesmo papel
   `role: 'admin'` que já existe na colecção `users` — é o único que
   pode criar, editar ou apagar categorias e definir quais entidades
   cada categoria cataloga automaticamente para _toda_ a plataforma.
   Uma edição deste nível afecta, por omissão, todos os utilizadores
   ao mesmo tempo. É o "catálogo de referência" do serviço.

2. **Nível pessoal (user).** Cada utilizador pode sobrepor o catálogo
   global com uma lista de **overrides pessoais**. Um override diz:
   _"no meu caso, quando vires esta entidade, cataloga-a nesta
   categoria em vez daquela que o catálogo global diria"_. Os
   overrides nunca saem do user que os criou e nunca tocam no
   catálogo global.

O utilizador comum **não cria categorias** (isso é do admin) e **não
edita o catálogo global** (idem). A única coisa que faz é dizer "para
mim, esta entidade vai para esta categoria". Tudo o resto — qual é a
lista de categorias disponíveis, como elas se chamam, qual o catálogo
base — é decidido pelo admin e herdado por todos.

### 3.2 Quem edita o quê

| Objecto | User comum | Admin |
|---------|------------|-------|
| Lista de categorias (criar, renomear, apagar) | — | ✓ |
| Catálogo global de entidades de uma categoria | — | ✓ |
| Overrides pessoais (próprios) | ✓ | ✓ |
| Overrides pessoais de outro user | — | — |
| `category_id` de uma despesa individual | ✓ (só as suas) | ✓ (só as suas) |

Um admin, quando está a usar a sua própria conta, tem os _mesmos_
overrides pessoais que qualquer outro user — os overrides são
sempre pessoais, nunca globais. Ser admin não desliga a camada
pessoal; ser admin só _acrescenta_ a capacidade de mexer no nível
global.

### 3.3 Exemplo concreto — Lidl

O caso que o produto tem de resolver:

1. O **admin** decide que, por omissão, despesas cuja entidade seja
   "Lidl" pertencem à categoria **Supermercado**. Adiciona a string
   "Lidl" ao catálogo global da categoria Supermercado.
2. A partir desse momento, qualquer user da plataforma que sincronize
   despesas do Curve vê as suas idas ao Lidl caírem automaticamente em
   Supermercado. Nada mais é preciso do lado do user.
3. Um user em particular — chamemos-lhe o Filipe — só vai ao Lidl
   comprar café. Para ele, categorizar Lidl como Supermercado distorce
   o dashboard e mete-lhe despesas de café fora da categoria Café.
4. O Filipe abre o ecrã de categorias, entra na categoria **Café** e
   cria um override pessoal: "Lidl → Café". Só isto.
5. A partir desse momento:
    - As despesas **do Filipe** no Lidl passam a ir para Café.
    - As despesas **de qualquer outro user** no Lidl continuam a ir
      para Supermercado, exactamente como antes. O catálogo global
      não foi tocado.

Se mais tarde o Filipe apagar o seu override, o comportamento
reverte: a partir daí volta a receber Supermercado no Lidl, como toda
a gente.

### 3.4 Ordem de resolução

Para cada despesa importada, o sistema resolve a categoria por esta
ordem determinística (detalhe algorítmico no capítulo 5):

1. **Overrides pessoais do user dono da despesa.** Se alguma regra
   pessoal casar com a entidade, essa regra vence sempre — é a
   promessa do "para mim, isto é assim".
2. **Catálogo global.** Se nenhum override casar, recorre-se ao
   catálogo global (o `Category.entities[]` que o admin mantém).
3. **Sem categoria.** Se nenhuma das duas camadas casar, a despesa é
   gravada com `category_id = null` e aparece no UI como
   "sem categoria", aguardando classificação manual ou uma nova regra.

O ponto-chave é a _estrita ordem entre camadas_: um override pessoal
nunca é "somado" ao global — _substitui-o_. O Filipe pode ter Lidl →
Café mesmo que o global diga Lidl → Supermercado, e o sistema honra
a decisão pessoal sem ambiguidade.

### 3.5 "Apply to all" — aplicar a despesas passadas

Por omissão, qualquer edição de regras (global ou pessoal) afecta
apenas **despesas futuras**. As despesas que já foram importadas
mantêm o `category_id` que tinham no momento do insert. Isto é
deliberado: muitas edições são tentativas, e não queremos que
afinar uma regra reescreva meses de histórico sem o utilizador o ter
pedido.

Ao mesmo tempo, o caso de uso real é retroactivo: quando o Filipe
cria o override Lidl → Café, ele _quer_ que as idas anteriores ao
Lidl que já tinham sido catalogadas como Supermercado passem também
para Café — senão o dashboard dele continua com os dados errados
para sempre.

A resposta é um **botão "Aplicar a despesas passadas"** que aparece
logo após qualquer edição de regras, com estas propriedades:

- **Visível sempre que uma regra muda** — criar, editar ou apagar um
  override pessoal, adicionar ou remover uma entidade no catálogo
  global, mudar o nome de uma categoria que tenha entidades
  catalogadas.
- **Opt-in explícito.** Nunca é automático. Se o user clicar noutro
  sítio ou fechar o ecrã, a edição vale só daí para a frente.
- **Pré-visualização.** Antes de confirmar, mostra quantas despesas
  vão ser afectadas. Esta contagem é o sinal de "estás mesmo a
  reescrever histórico — sabes o que estás a fazer".
- **Escopo correspondente ao nível da regra.**
    - Override pessoal → só as despesas _desse_ user são tocadas.
      Os outros users nunca são afectados.
    - Regra global editada pelo admin → apenas as despesas de users
      que _ainda não têm_ um override pessoal conflituante. Os
      overrides pessoais são sagrados: um apply-to-all global nunca
      os sobrepõe.
- **Auditável.** Cada execução fica registada em `curve_logs` com
  contexto suficiente para investigar: quem clicou, qual foi a
  regra, quantas despesas foram tocadas e qual era o `category_id`
  anterior de cada uma. A implementação detalhada está no
  capítulo 6.

### 3.6 Invariantes que a arquitectura preserva

Independentemente do schema, da API ou da UI, estas propriedades
têm de se manter verdadeiras em qualquer ponto no tempo:

- **Isolamento pessoal.** Nada que um user faça pode alterar a
  experiência de outro user. Overrides são privados por construção.
- **Primazia do pessoal.** Um override pessoal vence sempre a
  regra global correspondente, sem excepção.
- **Não-destruição silenciosa.** Uma mudança de regra nunca reescreve
  `category_id` de despesas passadas sem o user pedir explicitamente
  via apply-to-all.
- **Respeito pelo schema partilhado.** O nível global vive na
  colecção `categories` partilhada com Embers e respeita o schema
  canónico. Toda a extensão (overrides, metadados de match, etc.)
  vive em colecções novas pertencentes a Curve Sync, sem poluir o
  schema Embers.
- **Transparência de decisão.** Dada uma despesa, o sistema consegue
  sempre responder à pergunta _"porque é que esta despesa ficou nesta
  categoria?"_ — com a regra exacta (pessoal ou global) que decidiu.
  Isto é o que torna a automação confiável; a materialização prática
  aparece no capítulo 9 (UIX).

## 4. Modelo de dados

O capítulo 3 desenhou o sistema ao nível do modelo mental: dois
níveis, overrides pessoais, apply-to-all opcional. Este capítulo
traduz esse modelo em MongoDB. As decisões-chave, antes dos detalhes:

- O **catálogo global** continua numa colecção partilhada com Embers
  (`categories`) e o seu schema não muda nem um bit.
- A **camada pessoal** vive numa **colecção nova**
  (`curve_category_overrides`), 100% pertencente a Curve Sync, que o
  Embers não precisa de ler nem de escrever.
- A colecção `expenses` **relaxa** uma das suas regras de acesso para
  permitir UPDATE do campo `category_id`, e só desse campo. É a única
  mexida necessária para suportar apply-to-all.

Tudo o resto — totais por categoria, trend mensal, contadores de
entidades — é derivado à leitura e nunca persistido.

### 4.1 Vista geral das três camadas

```
┌────────────────────────────┐        ┌─────────────────────────┐
│  categories (partilhado)   │        │  users (partilhado)     │
│  ─ name                    │        │  ─ email                │
│  ─ entities[]  (admin)     │◄──┐    │  ─ role (user|admin)    │
│  ─ icon                    │   │    └─────────┬───────────────┘
│  ─ timestamps              │   │              │
└──────────┬─────────────────┘   │              │ user_id
           │                     │              │
           │ category_id         │              │
           │                     │              ▼
           │   ┌─────────────────┴────────────────────────────┐
           │   │  curve_category_overrides (Curve Sync)       │
           │   │  ─ user_id         (ref User)                │
           │   │  ─ category_id     (ref Category)            │
           │   │  ─ pattern         (raw, como o user escreve)│
           │   │  ─ pattern_norm    (derivado, indexável)     │
           │   │  ─ match_type      (exact|starts_with|contains)
           │   │  ─ priority        (desempate, default 0)    │
           │   │  ─ timestamps                                │
           │   └──────────────────────────────────────────────┘
           │
           ▼
┌────────────────────────────┐
│  expenses (partilhado)     │
│  ─ entity                  │
│  ─ amount / date / card    │
│  ─ digest (unique)         │
│  ─ user_id                 │
│  ─ category_id   ◄── agora UPDATÁVEL (ver §4.4)
│  ─ timestamps              │
└────────────────────────────┘
```

### 4.2 `categories` — schema partilhado, sem alterações

O schema canónico (`docs/embers-reference/models/category.rb`,
`server/src/models/Category.js`) mantém-se exactamente como hoje:

```javascript
// server/src/models/Category.js — sem diffs no schema
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

**O que muda** não é o schema mas sim as **regras de acesso**: o
CLAUDE.md actual diz "READ-ONLY (owned by Embers)"; passa a dizer
"FULL CRUD, reservado a admin" (ver capítulo 7 para o middleware e
capítulo 11 para a mudança na regra em CLAUDE.md). O que continua
proibido:

- Adicionar campos novos. `match_type`, `priority`, `color`,
  `global_vs_user_flag`, `regex_pattern` — nada disso entra aqui. A
  riqueza de metadados vive em `curve_category_overrides` (§4.3).
- Alterar índices existentes.
- Tocar nos campos `icon_*` que o Paperclip do Embers gere.

**Como o catálogo global é interpretado pelo matcher.** Cada entry
do array `entities[]` é tratado pelo Curve Sync como um padrão
`contains`, aplicado depois de normalização (capítulo 5). Isto é o
comportamento actual já implementado em `assignCategoryFromList`,
formalizado como contrato: não há `match_type` por entry no catálogo
global, porque não há onde o guardar sem mexer no schema. Se um
admin quiser precisão extra — por exemplo, "Lidl" como prefix em vez
de contains — pode sempre escrever entradas mais específicas (`Lidl
Cascais`, `Lidl Lisboa`) e deixar o longest-match-wins desempatar.

### 4.3 `curve_category_overrides` — colecção nova, pertence a Curve Sync

É aqui que vive toda a camada pessoal. Schema proposto:

```javascript
// server/src/models/CategoryOverride.js (novo)
const categoryOverrideSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    // O padrão tal como o user o escreveu (preservado para mostrar
    // na UI sem surpresas tipo "escrevi 'Lidl' e agora aparece 'lidl'").
    pattern: {
      type: String,
      required: true,
      trim: true,
    },
    // Forma normalizada (lowercase, sem diacríticos, espaços
    // colapsados, sufixos residuais removidos). É esta que o matcher
    // usa E é esta que entra no índice único — garante que "Lidl",
    // " lidl " e "LIDL" são considerados o mesmo padrão para efeitos
    // de duplicados. A regra exacta de normalização vive no cap. 5.
    pattern_normalized: {
      type: String,
      required: true,
    },
    match_type: {
      type: String,
      enum: ['exact', 'starts_with', 'contains'],
      default: 'contains',
      required: true,
    },
    // Desempate manual quando várias regras do MESMO user casam a
    // mesma despesa. Não é o mecanismo principal — longest-match-wins
    // cobre a maior parte dos empates. Fica como válvula de escape
    // para power-users.
    priority: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    collection: 'curve_category_overrides',
  },
);

// Dois overrides do mesmo user com o mesmo padrão normalizado são
// proibidos — senão não há forma de decidir qual vence sem recorrer a
// ordem de insert, que é frágil. Se o user quiser mudar a categoria
// de "Lidl", edita o override existente em vez de criar outro.
categoryOverrideSchema.index(
  { user_id: 1, pattern_normalized: 1 },
  { unique: true },
);

// Query quente: o sync orchestrator carrega TODOS os overrides do
// user dono do config no arranque de cada run. Este índice cobre a
// leitura por user_id puro. Ver §4.5.
categoryOverrideSchema.index({ user_id: 1 });
```

**Porquê uma colecção nova em vez de embutir nos documentos do
`Category`.** Três razões, por ordem de peso:

1. A regra inviolável de não mexer no schema partilhado com Embers.
2. Overrides são **por user**; guardá-los dentro de `Category`
   obrigaria a um sub-documento-por-user que explodiria o tamanho
   médio dos docs da categoria e misturaria dados globais com dados
   pessoais.
3. A query quente do sync orchestrator é "carrega todos os overrides
   do user _X_", não "carrega todas as regras da categoria _Y_". Uma
   colecção dedicada com índice `{ user_id: 1 }` serve exactamente
   essa query em O(log n).

**Porquê `pattern` + `pattern_normalized` em vez de só um dos
dois.** `pattern` é o que o user vê e edita; `pattern_normalized` é
o que o matcher compara e o que tem unicidade. Manter os dois
separados evita ter de re-normalizar em cada leitura, torna o
índice determinístico e permite mostrar o original na UI mesmo que
a normalização mude no futuro (migração: recalcular
`pattern_normalized` em massa, `pattern` fica intocado).

### 4.4 `expenses` — relaxação mínima para apply-to-all

O CLAUDE.md actual diz explicitamente:

> - **`expenses`** — READ + INSERT only (never UPDATE/DELETE existing
>   records)

Esta regra trava o apply-to-all: reescrever `category_id` de despesas
passadas é, por definição, um UPDATE. A regra passa a ter uma
excepção única, explícita e enforced na camada de serviço:

> - **`expenses`** — READ + INSERT + UPDATE (**apenas do campo
>   `category_id`**). Todos os outros campos permanecem imutáveis;
>   DELETE continua proibido.

**Enforcement.** O schema Mongoose não tem forma nativa de proibir
UPDATEs granulares. A disciplina é garantida em **duas camadas**:

1. **Serviço dedicado.** Todas as reescritas retroactivas passam por
   uma única função utilitária (provisoriamente
   `services/expense.js :: reassignCategoryBulk(filter, category_id)`)
   que só emite `Expense.updateMany(filter, { $set: { category_id
   } })`. Nenhuma outra função no codebase tem licença para chamar
   `Expense.update*` com campos que não sejam `category_id`.
2. **Code review.** A regra fica documentada no CLAUDE.md (capítulo
   11) e em jsdoc acima da função, como banner visível.

**O que continua proibido, por design:**

- UPDATE de `entity`, `amount`, `date`, `card`, `digest`, `user_id` —
  reescrever qualquer um destes partiria o mecanismo de dedup
  (`digest`) ou o isolamento por user, e ultrapassaria o contrato
  com Embers.
- DELETE de despesas. Só o Embers tem a lógica de "undo" para
  expenses; Curve Sync nunca apaga.

**Nota sobre `updated_at`.** A opção `timestamps: { updatedAt:
'updated_at' }` do Mongoose actualiza automaticamente o campo a
cada `updateMany`/`updateOne` com top-level `$set`, o que é o
comportamento desejado: uma despesa re-catalogada fica com
`updated_at` a apontar para o momento do apply-to-all, o que ajuda
auditoria e debugging sem mexer noutro lado.

### 4.5 Índices e queries quentes

| Query | Onde | Índice que serve |
|-------|------|------------------|
| "Dá-me as categorias ordenadas por nome" (listar categorias) | `GET /api/categories` | `{ name: 1 }` (já existe por ser `unique`) |
| "Dá-me todos os overrides do user X" (sync orchestrator, carregamento inicial) | `CategoryOverride.find({ user_id })` | `{ user_id: 1 }` (novo) |
| "Existe um override do user X com este padrão normalizado?" (criar override) | insert check | `{ user_id: 1, pattern_normalized: 1 }` unique (novo) |
| "Dá-me o total do mês em despesas do user X por `category_id`" (ecrã /categories) | aggregate `expenses` | `{ user_id: 1, date: 1 }` existe via `{ digest: 1, user_id: 1 }`? **não** — é um índice composto diferente. Esta query vai usar um scan filtrado por `user_id` + `date`. Se a telemetria mostrar latência relevante, adicionamos `{ user_id: 1, date: 1 }` como índice dedicado. |
| "Quantas despesas do user X têm entity que case com este padrão?" (pré-visualização do apply-to-all) | `Expense.countDocuments({ user_id, entity: regex })` | scan por `user_id`; o filtro de entity é regex, não beneficia de índice. É aceitável: operação cold, disparada por clique humano, não por loop. |

Nenhuma destas queries é nova para o Curve Sync em termos de custo —
as despesas já são lidas por user no dashboard e na `/expenses`, e
as categorias já são carregadas no arranque do sync. O único índice
verdadeiramente novo é o `{ user_id, pattern_normalized }` unique
em `curve_category_overrides`, que é pequeno (cabe inteiro em RAM
mesmo com centenas de overrides por user).

### 4.6 Compatibilidade Mongoose ↔ Mongoid

A checklist que já governa as outras colecções Curve-Sync-owned
continua a aplicar-se à colecção nova:

- `timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }`.
  Snake_case obrigatório — é o que o Mongoid espera e o que torna
  `curve_category_overrides` legível por qualquer ferramenta que
  inspeccione a base partilhada.
- `collection: 'curve_category_overrides'` explícito. Sem isto o
  Mongoose pluraliza (ou deixa singular, depende da versão) e
  partiria os scripts de inspecção.
- Referências sempre como `mongoose.Schema.Types.ObjectId`, nunca
  como `String`. `user_id` tem de ser um ObjectId genuíno para
  `populate` e aggregate cross-collection funcionarem.
- Não usar `strict: false` nesta colecção — é 100% propriedade do
  Curve Sync, o schema é o source of truth, campos fantasma são
  bugs.
- Nada de `_type` discriminator, nada de STI — uma classe, uma
  colecção, uma intenção.

Com isto, o modelo de dados fica especificado sem nenhuma ambiguidade:
`categories` é partilhado e inalterado; `curve_category_overrides` é
novo e bem indexado; `expenses` cede exactamente uma excepção,
enforced no serviço. O capítulo 5 começa a descrever como é que a
função de matching usa estas três camadas em conjunto.

## 5. Algoritmo de matching

Uma despesa entra com uma string de entidade bruta; tem de sair com
um `category_id` (ou `null`). Este capítulo define o algoritmo que
faz essa tradução, os seus custos, e as estruturas que o suportam.
Existe **uma única função** de resolução, partilhada pelos três
consumidores — `POST /api/expenses`, sync orchestrator e apply-to-all
(capítulo 6).

### 5.1 Pipeline

```
raw entity  →  normalize  →  resolveCategory(norm, ctx)  →  category_id | null
```

`ctx = { userRules, globalRules }` — o contexto é carregado à boca
do pipeline e reutilizado enquanto o chamador quiser. Quem chama
decide: o sync orchestrator carrega-o uma vez por run; o route
handler carrega-o por request; o apply-to-all carrega-o por
execução.

### 5.2 Normalização

Seis passos, por esta ordem, determinísticos e idempotentes
(`normalize(normalize(x)) === normalize(x)`):

1. Unicode NFD (decompor acentos do char base).
2. Strip dos combining marks (`\p{M}`) — tira os diacríticos.
3. `toLowerCase()`.
4. Substituir qualquer char não-alfanumérico por espaço.
5. Colapsar whitespace consecutivo num único espaço.
6. `trim()`.

Exemplos:

| Input bruto | Output normalizado |
|-------------|--------------------|
| `LIDL CASCAIS PT` | `lidl cascais pt` |
| `Café` | `cafe` |
| `McDONALDS*PICOAS` | `mcdonalds picoas` |
| `MB WAY - BAKERY 123` | `mb way bakery 123` |

Custo: `O(L_e)` onde `L_e` é o comprimento da string. Executado uma
vez por despesa, nunca por cada regra comparada.

### 5.3 Tipos de match

Aplicados sempre sobre strings **já normalizadas**:

- **`exact`** — `norm === pattern`
- **`starts_with`** — `norm === pattern || norm.startsWith(pattern + ' ')` (o espaço à direita é um word-boundary barato que impede "lidl" de casar "lidlmart")
- **`contains`** — `norm.includes(pattern)`

O catálogo global (capítulo 4.2) só suporta `contains` implícito — é
o que cabe no `entities[]` partilhado com Embers. Os overrides
(`curve_category_overrides`) podem escolher qualquer um dos três.

### 5.4 Resolução e tie-breaking

```
resolveCategory(raw, ctx):
  if !raw: return null
  norm = normalize(raw)
  best = null

  for r in ctx.userRules:
    if matches(norm, r): best = pickBetter(best, r)
  if best: return best.category_id          // short-circuit: user vence sempre

  for r in ctx.globalRules:
    if matches(norm, r): best = pickBetter(best, r)
  return best?.category_id ?? null
```

Dentro de cada tier **não há early return na regra** — o loop
colecciona todos os matches e deixa o `pickBetter` escolher. Só a
fronteira entre tiers faz short-circuit (cap. 3.4: override pessoal
substitui o global, não se acumula).

**Ordem estrita de `pickBetter`:**

1. `priority` (maior vence) — válvula de escape manual.
2. Comprimento de `pattern_normalized` (maior vence) — longest-match.
3. Especificidade do `match_type` (`exact > starts_with > contains`).
4. `created_at` ascendente — desempate final, determinístico.

A ordem é arbitrária mas estável: dois runs com os mesmos inputs
devolvem o mesmo output, sempre.

### 5.5 Estruturas de dados e caching

- **Overrides** vêm da DB já com `pattern_normalized` pré-computado
  (cap. 4.3). Não há normalização em tempo de matching.
- **Globais** são plain strings no `Category.entities[]`; o cache
  build pré-normaliza-os uma única vez por `loadContext()`. Cada
  entry passa a `{ category_id, pattern_normalized, match_type:
  'contains' }`.
- Estrutura final em memória: dois arrays planos, `userRules` e
  `globalRules`. **Sem trie, sem Aho-Corasick** — linear scan é
  barato à escala esperada (ver §5.6).

Consumo de memória típico: ~120 regras × ~40 bytes cada ≈ 5 KB. O
cache cabe trivialmente ao lado do `categoriesCache` que o
orchestrator já mantém.

### 5.6 Análise de complexidade

Notação:

- `G` — número de regras globais (soma de `|entities[]|` em todas as
  categorias).
- `U` — número de overrides do user activo.
- `N` — despesas processadas num run.
- `L_e` — comprimento médio da entidade (~30 chars).
- `L_p` — comprimento médio do padrão (~10 chars).

**Por despesa:**

```
normalize:    O(L_e)
match loop:   O((G + U) × L_e)       -- cada teste é um substring scan
-----------------------------------
total:        O((G + U) × L_e)
```

**Por sync run:**

```
cache build:  O(G × L_p + U)         -- só globais precisam de normalizar
N despesas:   O(N × (G + U) × L_e)
-----------------------------------
total:        O(G × L_p + N × (G + U) × L_e)
```

**Números concretos** a escala esperada do MVP (`G=100`, `U=20`,
`N=1000`, `L_e=30`):

- Por despesa: `(100 + 20) × 30 = 3,600` comparações de char
- Por sync: `3,600 × 1000 ≈ 3.6M` comparações de char
- Tempo wall-clock num Raspberry Pi: **single-digit milissegundos**
  para o sync inteiro

**Comparação com o custo dominante** de um sync:

| Fase | Tempo típico por email |
|------|-----------------------|
| IMAP fetch + decrypt | 100-500 ms |
| Parse cheerio | 1-5 ms |
| **Matching (esta camada)** | **~3 μs** |
| `Expense.create` | 5-20 ms |

O matching é cinco ordens de grandeza mais barato do que o fetch.
Qualquer optimização estrutural (trie, Aho-Corasick, índice
invertido) é desperdício — o tempo gasto a implementar e manter não
é recuperado em nenhum cenário realista.

**Quando revisitar:** se a telemetria mostrar `G × U × N > 10⁸` — na
prática, plataforma com 100+ users, catálogo global com 1000+
regras, e 10k+ despesas por sync. Fora do horizonte do MVP.

### 5.7 Dois pontos de consumo (custo de DB)

| Consumidor | Queries ao carregar ctx | Reutilização |
|------------|------------------------|--------------|
| `POST /api/expenses` | 2 (globais + overrides do user autenticado) | não, request único |
| Sync orchestrator | 2 (no run start) | sim, para os N emails do run |
| Apply-to-all (cap. 6) | 2 (no handler) | sim, para todos os candidatos |

Os três reutilizam a mesma função `loadContext(user_id)`.

### 5.8 Casos-limite

- **`raw` vazia ou `null`** → devolve `null` imediatamente.
- **`pattern_normalized` vazio** depois de normalizar — rejeitado à
  escrita do override (validação no serviço, não no matcher).
- **Sem match algum** → `category_id = null`. Não há fallback
  "General" à maneira do Embers; uma despesa sem categoria
  aparece marcada como tal na UI e fica à espera de uma regra ou
  de classificação manual.
- **Unicode / emoji** → passam por normalize, viram espaço no passo
  4, e deixam de casar qualquer regra. Comportamento aceitável.
- **Padrão patológico** (ex.: `"a"` com `contains`) — longest-match
  neutraliza-o se houver qualquer regra mais específica. Para
  travar a montante, a UI avisa à escrita sempre que
  `pattern_normalized.length < 3`.
- **Empate absoluto** (mesma prioridade, mesmo comprimento, mesmo
  match_type, mesmo `created_at`) — na prática, impossível dentro da
  mesma colecção por causa do índice único
  `{ user_id, pattern_normalized }`. Entre global e user, o
  short-circuit já resolveu antes de chegar aqui.

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
