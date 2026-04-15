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

**Consumidores desta relaxação.** A operação `reassignCategoryBulk`
é chamada em dois sítios: (1) apply-to-all retroactivo (capítulo
6), que opera sobre um filtro do tipo `{ entity_normalized,
user_id }` e toca potencialmente milhares de documentos; e (2)
quick-edit single-expense inline nas tabelas `/expenses` e `/`
(capítulo 12), que passa o mesmo helper mas com um filtro
`{ _id, user_id }` — uma única despesa. O contrato do helper é
filter-agnóstico precisamente para suportar ambos os casos com
um único caminho auditado.

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

Qualquer edição de regras (global ou pessoal) afecta por omissão só
despesas futuras. Este capítulo define o mecanismo explícito para
reescrever também as despesas já importadas, dentro das invariantes
do capítulo 3.6 e sem duplicar lógica do capítulo 5.

### 6.1 Princípios

- **Opt-in explícito.** Nunca automático. Cada execução é disparada
  por um clique humano, nunca como efeito colateral de um save.
- **Reutiliza o resolver do cap. 5.** Zero lógica de matching
  duplicada. Apply-to-all é "re-correr o resolver sobre um subset de
  despesas" — nada mais.
- **Escopo segue as invariantes do cap. 3.6.** Override pessoal
  afecta só o dono; apply-to-all global nunca sobrepõe overrides
  pessoais existentes.
- **Reversível por auditoria.** Cada execução fica registada com
  contexto suficiente para investigação ou undo futuro.

### 6.2 Eventos que activam o botão

| Evento | Activa apply-to-all? |
|--------|----------------------|
| Add entity no catálogo global (admin) | sim |
| Remove entity do catálogo global (admin) | sim |
| Create override pessoal (user) | sim |
| Edit override pessoal — pattern, match_type, target category | sim |
| Delete override pessoal | sim |
| Renomear categoria | **não** (nome não afecta matching) |
| Alterar ícone da categoria | **não** |

### 6.3 Superfície de trigger

- **UI:** imediatamente após um save com sucesso, aparece um toast
  ou banner com CTA `"Aplicar a N despesas passadas"`. Se o user
  fecha o ecrã ou clica noutro sítio, a edição vale só a partir dali.
- **API:** dois endpoints dedicados (detalhe no cap. 8):
  - `POST /api/categories/:id/apply-to-all` — para edições no
    catálogo global.
  - `POST /api/category-overrides/:id/apply-to-all` — para
    overrides pessoais.
- **Nunca como side effect** de um PUT/POST normal. Manter writes
  previsíveis é o que torna o sistema reversível.

### 6.4 Preview (dry run)

Antes de commit, o user vê o impacto. O mesmo endpoint aceita
`?dry_run=true` (ou o frontend chama primeiro um GET equivalente) e
devolve:

```json
{
  "count": 42,
  "samples": [
    { "_id": "...", "entity": "Lidl Cascais", "date": "2025-11-12", "current_category": "Supermercado", "new_category": "Café" },
    ...até 10 exemplos
  ]
}
```

Preview é barato: `countDocuments` + `find().limit(10)`. Se `count ==
0`, o botão desaparece sem round trip de commit.

### 6.5 Cálculo do escopo

**Override pessoal (user `U`, pattern `P`, target `C`):**

1. Candidate set: despesas com `user_id = U` e `entity` que case `P`
   após normalizar.
2. **Re-validação** por despesa: correr `resolveCategory(entity,
   ctx_U)` com o contexto **actualizado** do mesmo user.
3. Actualizar só onde `resolveCategory(...) !== expense.category_id`.

A re-validação é crítica: o user pode ter outro override mais
específico (ex.: `"lidl lisboa"`) que já esteja a vencer sobre o
novo (`"lidl"`). Sem re-validação, apply-to-all reescreveria
incorrectamente.

**Catálogo global (admin adiciona `"Lidl"` a Supermercado):**

1. Candidate set: despesas — de todos os users — com `entity` que
   case `"lidl"` após normalizar.
2. Re-validação por despesa: correr `resolveCategory(entity,
   ctx_ownerDaDespesa)`, construído com os overrides pessoais
   **desse** user.
3. Actualizar só onde o resultado difere.

A invariante "personal é sagrado" (§3.6) **emerge do algoritmo**:
se o owner tiver um override vencedor, `resolveCategory` devolve a
categoria pessoal, o `if` guarda a despesa como está, e apply-to-all
não toca. Nenhum special-case — é consequência natural de reutilizar
o resolver do cap. 5.

### 6.6 Execução

```
applyOverride(user_id, override):
  ctx = await loadContext(user_id)          // cap. 5.5
  candidates = await Expense.find({
    user_id,
    entity: coarseRegex(override.pattern_normalized)
  }).lean()

  toUpdate = Map<category_id, [expense_id]>()
  for e in candidates:
    new_cat = resolveCategory(e.entity, ctx)
    if new_cat !== String(e.category_id):
      toUpdate.get(new_cat).push(e._id)

  for [cat, ids] in toUpdate:
    await reassignCategoryBulk({ _id: { $in: ids } }, cat)   // §4.4
    await writeApplyToAllLog(...)                            // §6.8

  return { affected, skipped, duration_ms }
```

- **Pré-filtro Mongo** com regex coarse sobre `entity` é só para
  reduzir o candidate set. A fonte de verdade é a re-validação
  app-side — o regex pode ser tolerante (falsos positivos são OK, o
  loop filtra-os).
- **`reassignCategoryBulk`** é o único sítio no codebase autorizado a
  chamar `Expense.updateMany` com `{ $set: { category_id } }` (cap.
  4.4). Apply-to-all não invoca `updateMany` directamente.

### 6.7 Complexidade

Seja `k` o número de candidatos após pré-filtro, `G+U` o tamanho do
contexto, `L_e` o comprimento médio da entidade.

- Fetch: `O(M_u)` para o escopo pessoal (scan por `user_id` +
  regex), `O(M)` para o global (scan cross-user).
- Re-validação: `O(k × (G+U) × L_e)`.
- Bulk updates: `O(k / batch_size)` round trips, tipicamente 1-2.

Números concretos:

| Cenário | `M` | `k` | Tempo wall-clock |
|---------|-----|-----|------------------|
| Override pessoal, user com 10k despesas | 10k | ~50 | < 100 ms |
| Global, plataforma 10 users × 10k despesas | 100k | ~500 | < 1 s |

Corre **síncrono dentro do handler** enquanto `M < ~10⁶`. Acima
disso, a operação tem de passar para background job (fora do
escopo do MVP).

### 6.8 Atomicidade, auditoria e idempotência

- **Sem transações multi-doc.** `updateMany` batched é idempotente
  por construção — re-correr após crash salta rows já correctas, e
  a linha de guarda `new_cat !== current` garante isso.
- **Audit trail obrigatório.** Uma entrada em `curve_logs` por
  execução, com `action: 'apply_to_all'` (item #32 do catálogo do
  §13.2). O shape final segue o contrato do `CurveLog` actual
  — sem schema extension — e empacota `scope`, `target`,
  `affected`, `skipped_personal` no `error_detail` em formato
  k=v space-separated. O snapshot `before` proposto nas primeiras
  iterações deste capítulo ficou explicitamente de fora: é dead
  weight enquanto o undo estiver out-of-scope (§6.10) e pode ser
  reintroduzido como colecção dedicada quando o undo for
  implementado. Ver §13.3 para a justificação detalhada.
- **Idempotência por design.** Dois cliques seguidos no mesmo botão
  produzem o mesmo estado; o segundo run é no-op porque
  `resolveCategory` já devolve a categoria que lá está.

### 6.9 Casos-limite

- **Delete de override + apply-to-all** → re-resolver sem o override
  apagado; as despesas caem na regra que vencer a seguir (tipicamente
  a regra global, ou `null`).
- **Delete de categoria** → bloqueado pelo backend se existirem
  `expenses.category_id` a referenciar (cap. 7). O user tem de
  reassignar primeiro, a partir do ecrã. A UI força a ordem.
- **Renomear categoria** → não activa o botão (matching não muda).
- **`affected_count == 0`** → o botão não aparece; o preview devolve
  vazio e a UI esconde o CTA.
- **User sem despesas históricas** → idem, `affected == 0`, sem
  round trip desperdiçado.

### 6.10 Fora de escopo (fases futuras)

- **Undo** com base no snapshot `before` em `curve_logs`.
- **Execução async / background** com progress streaming para
  escopos acima de ~10⁶ despesas.
- **Apply-to-all inter-user fora de contexto admin** — nunca. Um
  user nunca mexe nas despesas de outro user, mesmo que o admin o
  autorize.

### 6.11 Entry-point adicional: quick-edit inline

O apply-to-all aqui descrito é activado principalmente a partir
do ecrã `/categories` (capítulo 9). **Existe um segundo
entry-point** com o mesmo pipeline subjacente: o popover de
quick-edit descrito no capítulo 12, accionado pelo click no chip
de categoria dentro das tabelas de `/expenses` e `/` (dashboard).
Nesse fluxo, o user tem um checkbox opt-in "Aplicar a todas as
despesas de *<entity>*" que, quando marcado, faz upsert de um
override pessoal (§4.3) e invoca imediatamente o mesmo
`POST /api/category-overrides/:id/apply-to-all` do §8.5. Toda a
mecânica (preview via `dry_run`, invariante "personal is sacred"
do §6.2, idempotência do §6.8) aplica-se sem alterações — o
popover é só uma superfície de UI diferente para a mesma
operação.

## 7. Autorização e papéis

O modelo de dois níveis do capítulo 3 assenta num sistema de
permissões trivial mas obrigatório: algumas rotas são exclusivas
de admins, outras são para qualquer user autenticado, e a distinção
tem de ser enforced no backend — nunca só no frontend.

### 7.1 Fonte da verdade do papel

O campo já existe no schema partilhado com Embers:

```javascript
// server/src/models/User.js
email:              String,
role:               String,   // 'user' | 'admin'
encrypted_password: String,
salt:               String,
```

Regras herdadas do CLAUDE.md (§MongoDB Collection Access Rules):

- `role` é validado à inserção via `hashPassword` helper e fixo em
  `'user'` para novos registos criados em Curve Sync.
- **Curve Sync nunca promove nem despromove** — a atribuição de
  `admin` continua exclusiva de Embers, que tem a "last admin"
  guard própria.
- O papel é **lido em runtime** a cada request, não guardado na
  `Session`. Se um admin for despromovido em Embers, a próxima
  chamada a uma rota admin-only falha com 403 sem precisar de
  logout forçado.

### 7.2 Middleware `requireAdmin`

Corre **sempre depois** de `authenticate` (que já valida o bearer
token e injecta `req.userId`).

```javascript
// server/src/middleware/requireAdmin.js (novo)
export async function requireAdmin(req, res, next) {
  const user = await User.findById(req.userId).select('role').lean();
  if (!user) return res.status(401).json({ error: 'Sessão inválida.' });
  if (user.role !== 'admin') {
    audit({
      action: 'admin_denied',
      userId: req.userId,
      ip: clientIp(req),
      detail: `${req.method} ${req.path}`,
    });
    return res.status(403).json({ error: 'Acesso reservado a administradores.' });
  }
  req.userRole = 'admin';
  next();
}
```

Duas leituras ao `users` por request admin (`authenticate` faz uma
implícita via `sessions`, `requireAdmin` faz outra explícita). Para
mitigar, pode-se cachear `role` em memória por `userId` com TTL
curto (ex.: 30 s) — optimização opcional, não bloqueante para o
MVP.

### 7.3 Matriz de permissões

| Rota | Público | User | Admin |
|------|---------|------|-------|
| `GET /api/categories` | — | ✓ | ✓ |
| `POST /api/categories` | — | — | ✓ |
| `PUT /api/categories/:id` | — | — | ✓ |
| `DELETE /api/categories/:id` | — | — | ✓ |
| `POST /api/categories/:id/entities` | — | — | ✓ |
| `DELETE /api/categories/:id/entities/:entity` | — | — | ✓ |
| `POST /api/categories/:id/apply-to-all` | — | — | ✓ |
| `GET /api/category-overrides` | — | ✓ (só os próprios) | ✓ (só os próprios) |
| `POST /api/category-overrides` | — | ✓ | ✓ |
| `PUT /api/category-overrides/:id` | — | ✓ (só os próprios) | ✓ (só os próprios) |
| `DELETE /api/category-overrides/:id` | — | ✓ (só os próprios) | ✓ (só os próprios) |
| `POST /api/category-overrides/:id/apply-to-all` | — | ✓ | ✓ |
| `GET /api/categories/stats` | — | ✓ | ✓ |

"Só os próprios" é enforced dentro do handler: qualquer `find` /
`findOne` / `updateOne` / `deleteOne` em `curve_category_overrides`
adiciona `user_id: req.userId` ao filtro. Um admin não pode ler nem
mexer nos overrides de outro user, mesmo com o papel `'admin'` —
isto materializa o isolamento pessoal do §3.6.

### 7.4 Duplo papel do admin

Ser admin **adiciona** capacidades globais; não substitui nada do
lado pessoal. Em particular:

- O admin tem os seus próprios overrides pessoais, geridos
  exactamente como um user comum.
- Um apply-to-all feito pelo admin num override **pessoal dele** só
  toca despesas do próprio admin — é indistinguível de um user
  normal a fazer o mesmo.
- Só as rotas sobre `categories` (catálogo global) e o apply-to-all
  de regras globais é que consomem o bit de admin.

Esta separação é o que permite que o admin use a app para gerir as
suas finanças sem efeitos colaterais no catálogo global.

### 7.5 Códigos HTTP e mensagens

- **401** (`Sessão inválida.`) — token em falta, expirado ou
  revogado. Tratado pelo `authenticate`.
- **403** (`Acesso reservado a administradores.`) — token válido,
  user autenticado, mas sem `role: 'admin'` para uma rota
  admin-only. Tratado pelo `requireAdmin`.
- **404** em vez de 403 para recursos de outros users — se um user
  tenta `GET /api/category-overrides/:id` de um override que
  pertence a outro, devolvemos 404 (não vaza a existência do
  recurso). O filtro `user_id: req.userId` no handler garante que o
  `findOne` devolve `null` e o handler responde `404 Override não
  encontrado.` sem leak.

Cada 403 gera um log `admin_denied` em `curve_logs` com método e
rota. 401 já tem audit trail via `authenticate`.

### 7.6 Casos-limite

- **Despromoção a meio de sessão.** Admin perde o papel em Embers;
  a próxima chamada admin falha 403, as restantes continuam a
  funcionar como user normal. Sem logout forçado.
- **Promoção a meio de sessão.** User torna-se admin em Embers; a
  próxima chamada a rota admin passa 200 sem precisar de re-login.
- **Admin sem categorias criadas.** `GET /api/categories` devolve
  `{ data: [] }` e o ecrã de gestão mostra empty state "Ainda não
  há categorias — cria a primeira."
- **Último admin apaga-se a si próprio.** Fora do escopo — o
  `destroy path` de `users` pertence a Embers e tem a "last admin"
  guard própria (CLAUDE.md §MongoDB Collection Access Rules). Curve
  Sync nunca apaga users.
- **Race** entre `POST /api/categories` e `DELETE
  /api/categories/:id`. Resolvido pelo `unique: true` do `name` e
  por 404 no handler do DELETE se o doc já não existir.

## 8. API

Os capítulos 3–7 definiram o *o quê* e o *porquê*. Este capítulo é a
tradução HTTP: lista fechada de endpoints, shape de request/response
e códigos de erro. Tudo assenta em `authenticate` + (opcional)
`requireAdmin`, com o filtro `user_id: req.userId` enforced dentro
dos handlers de overrides (ver §7.3).

### 8.1 Convenções

- **Base URL.** Tudo debaixo de `/api`. Sessão por cookie assinado
  (mesmo fluxo de `docs/AUTH.md`) — nenhum destes endpoints é público.
- **Content-type.** `application/json` em request e response.
- **Shape padrão de sucesso.** `{ data: ... }` (lista ou objecto).
  `POST` devolve `201 Created` + `{ data }`, `PUT` devolve `200` +
  `{ data }`, `DELETE` devolve `204 No Content`.
- **Shape padrão de erro.** `{ error: string, code?: string, field?:
  string }`. `code` é uma string estável (`name_taken`,
  `override_exists`, `category_not_found`, …) para o frontend
  distinguir sem parsear mensagens em português.
- **Rate limiting.** Os endpoints de escrita (`POST`/`PUT`/`DELETE` +
  `apply-to-all`) passam pelo mesmo `express-rate-limit` já usado em
  `auth` (30 req/min por IP). `apply-to-all` tem um cap adicional
  de 10 execuções por hora por user (§6.4 já assume isto).

### 8.2 Catálogo global — `categories` (admin-only, excepto GET)

`GET /api/categories` — leitura aberta a qualquer user autenticado.

```json
// 200 OK
{
  "data": [
    {
      "id": "65f…",
      "name": "Groceries",
      "entities": ["lidl", "continente", "pingo doce"],
      "icon_url": "/images/categories/groceries.png",
      "created_at": "2024-01-12T…",
      "updated_at": "2024-03-04T…"
    }
  ]
}
```

`POST /api/categories` — cria categoria global (admin). Body:

```json
{ "name": "Groceries", "entities": ["lidl", "continente"] }
```

- `201` → `{ data: Category }`
- `400 name_required` — `name` vazio ou em falta
- `409 name_taken` — já existe categoria com esse `name`
  (case-insensitive)
- `403` — sem `role: 'admin'`

`PUT /api/categories/:id` — edita nome e/ou ícone (o array
`entities` é mexido pelos endpoints granulares de §8.3, não aqui).
Body aceita `{ name?: string, icon_url?: string }`.

- `200` → `{ data: Category }`
- `404 category_not_found`
- `409 name_taken`
- `403`

`DELETE /api/categories/:id` — apaga categoria. Regras:

- Bloqueado se houver `expenses` ou `curve_category_overrides` a
  referenciar a categoria → `409 category_in_use` com
  `{ expenses_count, overrides_count }` no body para o modal do
  frontend informar o admin.
- O admin só consegue apagar depois de reatribuir os refs (ou
  aceitar o apply-to-all inverso, fora do escopo do MVP).
- `204` em sucesso.

### 8.3 Catálogo de entidades globais (admin-only)

Evita `PUT` pesado da categoria inteira e garante auditoria
granular.

`POST /api/categories/:id/entities` — adiciona N entidades ao
catálogo global:

```json
{ "entities": ["mercadona", "auchan"] }
```

- Normalização acontece no server (§5.2). Duplicados (já
  existentes, em qualquer forma normalizada) são descartados sem
  erro.
- Se alguma das entidades já estiver noutra categoria global, o
  handler devolve `409 entity_conflict` com `{ conflicts: [{ entity,
  category_id, category_name }] }`. O admin decide no frontend se
  faz *move* (remove da origem + adiciona aqui) — operação separada,
  não implícita.
- `200` → `{ data: Category }` (versão actualizada).

`DELETE /api/categories/:id/entities/:entity` — remove uma única
entidade do catálogo global. `entity` na URL vai URL-encoded e
match é feito sobre `pattern_normalized`. `204` em sucesso, `404
entity_not_found` caso contrário.

### 8.4 Overrides pessoais — `curve_category_overrides`

Todas as rotas abaixo correm com `authenticate` e aplicam
`user_id: req.userId` no filtro (§7.3). Admins não vêem overrides
alheios.

`GET /api/category-overrides` — lista os overrides do user:

```json
{
  "data": [
    {
      "id": "66a…",
      "category_id": "65f…",
      "category_name": "Coffee",
      "pattern": "Lidl",
      "pattern_normalized": "lidl",
      "match_type": "exact",
      "priority": 0,
      "matched_count": 15,
      "created_at": "…",
      "updated_at": "…"
    }
  ]
}
```

**`matched_count`** é o número de despesas do user que a regra
casa *agora*, independentemente de quem vence o tie-break do
resolver — é "quão larga é a rede desta regra", não "quantas
despesas mudam se aplicares apply-to-all" (essa conta é a do
§8.5, que já exclui os rows cuja categoria actual é a target).
Duas regras sobrepostas (`lidl` e `lidl cascais`) podem ambas
reportar `>0` mesmo que só uma ganhe a classificação final.

O count é calculado no GET, POST e PUT com uma agregação única
`{ entity → count }` por user + uma passagem in-memory que reutiliza
`categoryResolver.matches()`. Complexidade
`O(rules × distinct_entities)`; à escala MVP (~10k despesas, <50
entidades distintas) é uma operação de milissegundos, sem
round-trip extra — o `serialize()` já embrulha o número na
resposta, e o `/categories` usa-o para escrever `contains ·
prioridade 0 · 15 despesas` no subtítulo de cada regra.

`POST /api/category-overrides` — cria override pessoal. Body:

```json
{
  "category_id": "65f…",
  "pattern": "Lidl",
  "match_type": "exact",
  "priority": 0
}
```

- `201` → `{ data: Override }`
- `400 pattern_required` | `400 invalid_match_type` |
  `400 invalid_priority`
- `404 category_not_found` — `category_id` não existe no catálogo
  global
- `409 override_exists` — já existe override do mesmo user com o
  mesmo `(pattern_normalized, match_type)` (índice único de §4.3)

`PUT /api/category-overrides/:id` — edita um override. Só mexe em
`category_id`, `pattern`, `match_type`, `priority`.

- `200` → `{ data: Override }`
- `404 override_not_found` — inclui o caso de outro user (por
  §7.5, 404 em vez de 403)
- `409 override_exists` — edição colide com outro do próprio user

`DELETE /api/category-overrides/:id` — `204` em sucesso, `404
override_not_found` caso contrário.

### 8.5 Apply-to-all (retroactivo)

Dois endpoints separados, um por camada, ambos com a mesma semântica
descrita no capítulo 6.

`POST /api/categories/:id/apply-to-all` — admin-only, para regras
globais. Body opcional:

```json
{ "dry_run": false, "scope": "affected" }
```

- `scope: "affected"` (default) → só expenses cuja
  `entity_normalized` bate com o `pattern_normalized` da categoria.
- `scope: "missing"` → só expenses sem `category_id` (cenário de
  primeira corrida).
- `dry_run: true` → não escreve, devolve só o preview.
- `200` → `{ data: { matched, updated, skipped_personal, dry_run } }`
  onde `skipped_personal` conta quantas expenses não foram tocadas
  porque o dono tem override pessoal (§6.2, "personal is sacred").
- `429 apply_to_all_rate_limited` — ultrapassou o cap por hora.
- `403` | `404 category_not_found`.

`POST /api/category-overrides/:id/apply-to-all` — user-side, para
regras pessoais. Mesmo shape de body e response, mas o filtro é
sempre `user_id: req.userId` (nunca toca despesas de outros users).
Sem flag `skipped_personal` — aqui só há o próprio.

- `404 override_not_found` em vez de 403 para overrides alheios.

### 8.6 Estatísticas — `GET /api/categories/stats`

Alimenta a strip de KPIs do ecrã de gestão (§9) e a coluna esquerda
do master-detail. Alinhado ao ciclo do dia 22 (`docs/expense-
tracking.md`).

Query params: `?cycle=current` (default) | `?cycle=previous` |
`?start=YYYY-MM-DD&end=YYYY-MM-DD`.

```json
{
  "data": {
    "cycle": { "start": "2026-03-22", "end": "2026-04-21" },
    "totals": [
      {
        "category_id": "65f…",
        "category_name": "Groceries",
        "total": 312.47,
        "expense_count": 18,
        "entity_count": 6
      }
    ],
    "grand_total": 874.12
  }
}
```

- `200` sempre — se o user não tem despesas, devolve `totals: []` e
  `grand_total: 0`.
- `400 invalid_range` — `start` > `end` ou formato inválido.

### 8.7 Quick-edit inline (delta do capítulo 12)

O capítulo 12 adiciona duas rotas novas à API, dedicadas ao
caminho single-expense e ao caminho multi-select da tabela de
despesas.

**Single-expense (§12.7):**

`PUT /api/expenses/:id/category` — actualiza apenas o
`category_id` de uma despesa. Body `{ category_id: ObjectId |
null }`. Enforced `user_id: req.userId` no filtro (cross-user
devolve 404 por §7.5).

- `200` → `{ data: Expense }`
- `400 invalid_category_id`
- `404 expense_not_found` (inclui cross-user)
- `404 category_not_found` (quando `category_id` não existe)

Qualquer user autenticado pode chamar — não requer `requireAdmin`.
O handler invoca `reassignCategoryBulk({ _id, user_id },
category_id)`, reutilizando o helper autorizado do §4.4 sem
abrir nenhuma nova superfície de escrita. O modo entity-wide do
popover (checkbox) reutiliza os endpoints de overrides do §8.4 e
de apply-to-all do §8.5 — nenhum delta adicional.

**Bulk multi-select (§12.12):**

`PUT /api/expenses/bulk-category` — reassigna até 500 despesas
numa única chamada. Body `{ ids: ObjectId[], category_id:
ObjectId | null }`. Enforced `user_id: req.userId` no filtro
(ids cross-user caem silenciosamente em `skipped`, sem 404 para
não revelar existência por §7.5).

- `200` → `{ data: { moved, skipped, target_category_name } }`
- `400 invalid_body` — `ids` vazio, não-array, >500, ou com
  ObjectIds inválidos
- `400 invalid_category_id` — `category_id` não é ObjectId nem `null`
- `404 category_not_found` — `category_id` não existe no catálogo

`skipped` cobre: rows cuja categoria actual já é a target, ids
duplicados no payload, e ids que o user não possui. A resposta
é agregada (um único número) — o handler não diz *quais* rows
fizeram skip para não vazar existência cross-user.

`reassignCategoryBulk` é chamado com filtro
`{ _id: { $in: ids }, user_id: req.userId }`, reutilizando o
helper autorizado do §4.4. Uma única linha de auditoria
`expense_category_changed_bulk` é escrita no final (§13.2 #36).

**Compact id-only read:**

`GET /api/expenses?fields=_id` — modo compacto do read path
existente (§2.4), usado pelo frontend para implementar o
"Seleccionar todas as N" do Gmail-style batch-move (§12.12).
Devolve `{ ids: string[], total: number }` em vez de
`{ data: Expense[], meta }`, aplicando o mesmo filtro do GET
normal mas só projectando `_id`.

- `200` → `{ ids: string[], total: number }`
- `400 bulk_too_large` — quando o filtro devolve mais de 500
  rows. Protege o servidor de payloads enormes e espelha o cap
  duro do `bulk-category`.

O cliente **tem de** verificar `total <= 500` na página corrente
antes de chamar — o `bulk_too_large` é o guardrail final, não a
UX. O frontend usa-o para decidir entre mostrar o link
"Seleccionar todas as N" ou o aviso "Mais de 500 — refina o
filtro" (§12.12).

### 8.8 Tabela-resumo de códigos de erro

| Code | HTTP | Onde |
|------|------|------|
| `name_required` | 400 | POST/PUT categories |
| `name_taken` | 409 | POST/PUT categories |
| `invalid_match_type` | 400 | POST/PUT overrides |
| `invalid_priority` | 400 | POST/PUT overrides |
| `pattern_required` | 400 | POST overrides |
| `category_not_found` | 404 | PUT/DELETE categories, POST overrides |
| `category_in_use` | 409 | DELETE categories |
| `override_not_found` | 404 | PUT/DELETE/apply overrides (inclui alheios) |
| `override_exists` | 409 | POST/PUT overrides |
| `entity_conflict` | 409 | POST categories/:id/entities |
| `entity_not_found` | 404 | DELETE categories/:id/entities/:entity |
| `apply_to_all_rate_limited` | 429 | POST apply-to-all (ambos) |
| `invalid_range` | 400 | GET categories/stats |
| `invalid_category_id` | 400 | PUT expenses/:id/category, PUT expenses/bulk-category |
| `expense_not_found` | 404 | PUT expenses/:id/category |
| `invalid_body` | 400 | PUT expenses/bulk-category (ids shape) |
| `bulk_too_large` | 400 | GET expenses?fields=_id (>500 rows) |

Os 401 e 403 genéricos (§7.5) não entram na tabela — são contratos
dos middlewares, não dos handlers.

## 9. UIX — ecrã único de gestão de categorias

Este capítulo desenha a rota nova `/categories` — um único ecrã que
serve CRUD, auditoria de gastos e gestão de overrides, sem modal
para operações básicas. O objectivo é transformar "gerir categorias"
num momento de *avaliação* (como estão os gastos este ciclo,
comparados com o histórico) e não num formulário administrativo.
Tudo assenta nos tokens de `docs/UIX_DESIGN.md` e nos dados de
`GET /api/categories/stats` (§8.6).

### 9.1 Rota, shell e layout master-detail

- Novo link na `Sidebar.jsx` com `FolderIcon`: `{ to: '/categories',
  label: 'Categorias' }`. Fica entre *Despesas* e *Configuração*.
- `PageHeader` reutilizado (título "Categorias", subtítulo com o
  range do ciclo actual: "22 mar – 21 abr").
- Grid principal:

```
┌────────── Distribution bar (h-2 stacked) ──────────┐
│  [█████ Food ████][███ Transport ███][██ …]        │
└─────────────────────────────────────────────────────┘
┌──────────────┬──────────────────────────────────────┐
│              │  Header editável · KPI strip         │
│  Lista de    │  Spark chart (6 ciclos)              │
│  categorias  │                                      │
│  (scroll)    │  Tabs: Entidades · Despesas          │
│              │                                      │
└──────────────┴──────────────────────────────────────┘
     320px                   1fr
```

Tailwind: `grid lg:grid-cols-[320px_1fr] gap-6`, com colapso para
uma coluna abaixo de `lg` (§9.9).

### 9.2 Distribution bar (vista macro)

Barra horizontal `h-2 rounded-full bg-sand-100 overflow-hidden`
com N segmentos coloridos — um por categoria. Width de cada
segmento = `category.total / grand_total`. Mount animation: cada
segmento anima de `0%` → target em 500 ms com `animationDelay`
sequencial (cascata esquerda→direita, 60 ms entre segmentos).

- **Interacção:** click selecciona a categoria no detail pane;
  hover clareia os restantes segmentos para `opacity-40` com
  `transition-opacity duration-200`.
- **Legenda implícita:** `title` com `"<nome> · €<total> · <pct>%"`
  — evita ocupar vertical space com uma legenda explícita.
- **Empty state do ciclo:** se `grand_total === 0`, a barra
  colapsa num `div` sand com texto centrado "Ainda sem despesas
  neste ciclo".

### 9.3 Lista de categorias (coluna esquerda)

Container: `rounded-2xl border border-sand-200 bg-white
overflow-hidden`. Header fino com ordenação (default: `total
desc`). Cada linha:

```
┌────────────────────────────────────────────────┐
│ ● Groceries                         €312,47    │
│   6 entidades · 18 despesas    ↑ +4%   ⚪→     │
└────────────────────────────────────────────────┘
```

- **Swatch** (`● h-2.5 w-2.5 rounded-full`) com a cor da categoria.
- **Nome** em `text-sm font-medium text-sand-900`.
- **Total EUR** à direita em `text-curve-700 font-semibold` (token
  de montante do §3 do UIX_DESIGN).
- **Linha secundária:** `text-xs text-sand-400` com contadores.
- **Delta badge:** `+4%` amber (attention), `−12%` emerald (win),
  `±0%` sand-400 — vs média das últimas 3 cycles da mesma categoria.
- **Mini ring chart (32×32)** no canto direito — detalhe no §9.8.
- **Estado activo:** `bg-curve-50 border-l-2 border-curve-700`
  (mesmo pattern dos nav links da sidebar).
- Stagger de entrada: `fade-in-up` com `animationDelay: i * 60ms`
  (mesmo pattern das tabelas existentes).

### 9.4 Painel de detalhe (coluna direita)

Dividido em três zonas empilhadas:

**Header editável.** Avatar/ícone (click abre file picker),
`<input>` inline com o nome (blur → `PUT /api/categories/:id`),
botões `btn-secondary` "Apply to all" (só aparece após edição
que afecte matching — ver §9.7) e `btn-icon` delete.

**KPI strip.** `grid grid-cols-4 gap-4` de stat cards mini:

| Label | Valor |
|-------|-------|
| Total do ciclo | €312,47 |
| Despesas | 18 |
| Entidades | 6 |
| Média por despesa | €17,36 |

Todos os valores numéricos usam `useCountUp(value, 800)` (§9.8) —
ao trocar de categoria, os números re-animam 0→target em paralelo,
dando a sensação de refresh fluido.

**Spark area chart (6 ciclos).** SVG `~280×64` com `<path>` de 6
pontos (últimos 6 ciclos do dia 22 para esta categoria), fill
`curve-700/10` + stroke `curve-700/60`. Ponto do ciclo actual
destacado com `<circle r=3>`. Hover nos pontos mostra tooltip
inline (`date + valor`). Entrada animada em §9.8.

**Tabs internas.** `Entidades` (default) · `Despesas recentes`.
Tabs reutilizam o pattern `rounded-xl px-3 py-1.5` do design
system, com estado activo `bg-sand-100 text-sand-900`.

### 9.5 Catálogo de entidades (tab interna)

```
┌─ Adicionar entidade ───────────────────── [+] ┐
│  > Procurar entidades...                       │
├────────────────────────────────────────────────┤
│ ☐ lidl            [global]   42 despesas      │
│ ☐ continente      [global]   31 despesas      │
│ ☐ pingo doce      [pessoal]   9 despesas      │
│ ...                                            │
└────────────────────────────────────────────────┘
[ Seleccionar todas ]   [ Mover para... ] [ Remover ]
```

- **Input inline** no topo (`<form onSubmit>`), submete → `POST
  /api/categories/:id/entities` (admin) ou cria override (user).
- **Lista virtualizada** só acima de 100 entradas (`react-window`
  opt-in; abaixo disso, lista normal sem dep externa). Isto
  resolve a preocupação de "catálogos muito extensos" — `Groceries`
  pode ter centenas de nomes sem travar render.
- **Search local** (filtro client-side, `useMemo`) sobre o catálogo
  carregado — debounce desnecessário (tudo em memória).
- **Bulk select + move:** checkbox em cada linha + barra de acções
  que aparece quando `selection.size > 0`. Modal de confirmação
  a listar conflitos (`409 entity_conflict` do §8.3).
- **Badges** `global`/`pessoal` reutilizam o token `Neutral` do
  §5.5 do UIX_DESIGN. `pessoal` ganha tint `curve-50` para
  diferenciar visualmente.

### 9.5.1 Formulário "Nova regra pessoal" — autocomplete + click-to-create

Sub-componente do painel "As minhas regras" dentro da tab
"Entidades" do §9.5. O input de texto `"Nova regra pessoal para
<Categoria>…"` ganha um dropdown de sugestões que reduz o atrito
de criar regras com padrões correctos.

**Fonte das sugestões.** Um único `GET /api/autocomplete/entity`
no `refreshAll()` da página — as entidades não mudam entre
categorias, logo não vale a pena re-fetch por selecção. O
endpoint agrega `Expense.distinct('entity')` por user e
**ordena por data mais recente** via `{ $max: '$date' }`, com
`created_at` como tiebreak:

```js
[
  { $match: { user_id, entity: { $nin: [null, ''] } } },
  { $group: {
      _id: '$entity',
      last_date: { $max: '$date' },
      last_created_at: { $max: '$created_at' },
    }
  },
  { $sort: { last_date: -1, last_created_at: -1, _id: 1 } },
]
```

Porquê recency em vez de alfabético: o user quer catalogar o
que *acabou* de ver no cartão, não o que sai primeiro num
`.sort()` UTF-16. `date` é string `YYYY-MM-DD`, por isso o `$max`
lexicográfico coincide com o verdadeiro máximo temporal sem
parsing.

**Filtro "já coberta".** Entidades que alguma regra existente
já apanha (**de qualquer categoria**, não só a actualmente
seleccionada) são podadas **antes** de entrarem no dropdown. O
cliente replica byte-a-byte o `normalize()` + os três branches
de `matches()` do resolver (§5.2, §5.3) num helper local
`entityCoveredByOverride()`. Assim a sugestão nunca aponta para
um conflito que o `POST /category-overrides` devolveria como
`409 override_exists` ou que o resolver faria match noutra
categoria.

**Interacção.**

- **Focus/typing** abre o dropdown; empty input mostra os 8 mais
  recentes; input com texto filtra via `includes(normalized)`
  também preservando a ordem recency-first; cap de 8 rows para
  não virar uma muralha de texto.
- **↑/↓** navegam no highlight (com wrap-around), **Enter**
  pica a row realçada, **Esc** fecha sem mexer no input.
- **Click no rato** usa `onMouseDown` em vez de `onClick` para
  disparar **antes** do `onBlur` do input — o delay de 120ms no
  blur fecha o dropdown cedo o suficiente para não atrapalhar.
- **Click-to-create.** Picar uma sugestão dispara
  **imediatamente** `onCreate({ pattern: entity })` em vez de
  apenas preencher o input. Não há dois cliques ("picar →
  Adicionar") — o user já confirmou a escolha ao picar uma row
  de uma lista que é garantidamente válida e livre. O botão
  `Adicionar` continua a existir para input digitado à mão.
- **Apply-to-all após create.** O fluxo do §9.7 dispara na
  mesma — o parent `handleCreateOverride` chama o dry-run de
  apply-to-all e mostra o banner "N despesas podem ser
  re-catalogadas" se `matched > 0`.

**Degradation graceful.** Se `/autocomplete` falhar, o fetch
cai em `{ data: [] }` em silêncio e o input volta a comportar-se
como text input normal — o dropdown nunca abre por falta de
candidates.

### 9.5.2 Contador "N despesas" por regra

Cada row em "As minhas regras" mostra no subtítulo
`<match_type> · prioridade <n> · N despesa(s)` usando o campo
`matched_count` do §8.4. Pluralização pt-PT (1 → "1 despesa",
N → "N despesas"). Quando `matched_count == null` (rows vindos
de caches pre-feature ou handlers que não computam o count), o
sufixo é omitido — a row renderiza limpa sem partir.

O cálculo é feito **server-side** no handler de `GET /category-
overrides` via `countMatchesPerRule()`, reutilizando
`categoryResolver.matches()`. Ver §8.4 para a semântica exacta
(é "largura da rede", não "quantas mudariam com apply-to-all").

### 9.6 Painel de despesas recentes (tab alternativa)

Tabela compacta com as últimas 10 despesas da categoria
seleccionada, reutiliza o componente existente da `ExpensesPage`
mas com `card`, `category`, `digest` escondidos (são redundantes
no contexto). Link no fundo "Ver todas →" abre
`/expenses?category=:name`.

### 9.7 Apply-to-all flow (UIX)

Qualquer edição que afecte matching (criar override, mover
entidade, alterar `match_type`) activa um banner inline na zona
do header do detail pane:

```
┌──────────────────────────────────────────────────┐
│ ℹ  Regra alterada. Aplicar a despesas passadas? │
│                          [ Ignorar ] [ Aplicar ] │
└──────────────────────────────────────────────────┘
```

`Aplicar` abre modal com preview (via `dry_run: true` do §8.5):

```
Vão ser re-catalogadas 47 despesas.
  ─ 42 pertencem a ti
  ─  5 são de outros users (protegidas por overrides pessoais)
Cancelar              Confirmar aplicação
```

Loading state no botão primário (`A aplicar...` + spinner,
conforme §10 do UIX_DESIGN). Sucesso → toast `slide-in-right`
(`"47 despesas re-catalogadas"`) + refresh dos totais no ecrã
(chamada silenciosa a `/api/categories/stats`).

### 9.8 Motion & grafismo

A peça central do capítulo. Tudo SVG inline + Tailwind + 1 hook
micro — nenhuma dependência externa (sem recharts, sem d3). Todas
as animações têm fallback para `prefers-reduced-motion: reduce`.

**1. Mini ring chart por linha.** 32×32 SVG com dois `<circle>`:
track `sand-200`, arco `curve-700` com `stroke-dasharray` animado
via `stroke-dashoffset` (600 ms `ease-out`). Mostra `spend /
avg` dessa categoria (cap a 150%). *Warm shift* da cor do arco:

| Ratio | Stroke |
|-------|--------|
| `< 80%` | `sand-500` (frio, relaxado) |
| `80–100%` | `curve-500` (atenção) |
| `> 100%` | `curve-700` + heat pulse |

**2. Heat pulse (over-budget).** Categorias com `spend > avg × 1.2`
ganham um halo subtil no swatch: `box-shadow: 0 0 0 4px
rgba(192,78,48,0.2)` pulsante em 2 s. Limitado a 3 iterações no
mount (não é loop infinito — respeita §4 do UIX_DESIGN "sem
loop"). Depois fica estático.

**3. Count-up nas KPIs.** Hook custom:

```javascript
// client/src/hooks/useCountUp.js (novo)
export function useCountUp(value, duration = 800) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    const start = performance.now();
    const from = 0;
    let raf;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      setDisplay(from + (value - from) * eased);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}
```

Ao trocar de categoria, as 4 KPIs re-animam 0→target em paralelo.
Custo: 4 rAFs por troca — negligível.

**4. Spark chart draw-in.** `<path>` ganha `stroke-dasharray:
<length>` + `stroke-dashoffset: <length>` no mount, animados para
`0` em 700 ms `ease-out` — efeito "drawing" da esquerda para a
direita. O fill aparece em `fade-in` paralelo (300 ms com 400 ms
de delay, para entrar *depois* do traço ter sido desenhado).

**5. Distribution bar width grow.** Cada segmento arranca com
`transform: scaleX(0); transform-origin: left` e anima para
`scaleX(1)` em 500 ms, com `animationDelay: i * 60ms`. Mesma
curva que a cascata da lista de categorias — os dois elementos
"respiram" em sincronia.

**6. Stagger da lista.** Linhas entram com `fade-in-up`
(`animationDelay: i * 60ms`) — herdado do pattern existente nas
tabelas de despesas recentes do Dashboard.

**7. Cross-fade ao trocar de categoria.** O detail pane usa
`key={categoryId}` no React para forçar remount, e entra com
`fade-in` (400 ms). Em paralelo, os count-ups arrancam. O
conjunto soa a "troca fluida" e não a refresh.

**8. Delta badges semânticos.** Reutilizam os badges do §5.5 do
UIX_DESIGN:

| Delta | Classe |
|-------|--------|
| `> +5%` | `bg-amber-50 text-amber-700` (attention) |
| `< −5%` | `bg-emerald-50 text-emerald-700` (win) |
| `±5%` | `bg-sand-100 text-sand-500` (neutral) |

**9. `prefers-reduced-motion: reduce`.** Bloco único no
`index.css`:

```css
@media (prefers-reduced-motion: reduce) {
  .animate-draw,
  .animate-grow,
  .animate-pulse-warm,
  .animate-fade-in,
  .animate-fade-in-up { animation: none !important; }
  [data-count-up] { /* render valor final directo */ }
}
```

O hook `useCountUp` também detecta `matchMedia('(prefers-reduced-
motion: reduce)')` e devolve `value` sem tween.

### 9.9 Modo admin vs modo user

O mesmo ecrã, `role`-adaptive. Diferenças resumidas:

| Zona | Admin | User |
|------|-------|------|
| Botão topo | `+ Categoria` (novo card) | — |
| Header editável (nome/ícone) | Editável | Read-only |
| Catálogo global | CRUD directo (`POST/DELETE .../entities`) | Read-only (badge `global`) |
| Overrides pessoais | CRUD dos próprios | CRUD dos próprios |
| Tab "Entidades" | Uma única lista mista | Duas secções: "Globais" (ro) + "As minhas regras" (crud) |
| Apply-to-all | Globais + pessoais | Apenas pessoais |

Gráficos (distribution bar, ring, spark, KPIs) são **sempre
pessoais** — os totais vêm das despesas do `req.userId`, tal como
no dashboard. Um admin não vê os gastos dos outros users no ecrã
de categorias.

### 9.10 Empty states e responsividade

**Empty states.**

- **Sem categorias no sistema.** Admin: empty state central
  "Cria a primeira categoria" + CTA primário. User: "Ainda não
  há categorias — contacta o admin." (Estes cenários são raros
  após o seed inicial — ver §11.)
- **User sem despesas no ciclo.** Lista aparece normalmente mas
  com ring charts a 0 e distribution bar colapsada. Detail pane
  mostra KPIs a `€0,00` + spark chart vazio + CTA "Sincronizar
  agora →" que liga ao dashboard.
- **Categoria sem entidades.** Tab *Entidades* com empty state
  `border-dashed` (§5.8 do UIX_DESIGN) e CTA "Adicionar primeira
  entidade".

**Responsividade.** Breakpoints consistentes com §12 do
UIX_DESIGN.

- `< lg` (1024 px): colapsa para uma única coluna. A lista vira
  um `<select>` nativo ou um drawer overlay (decisão deferida
  para o PR de implementação — ambos servem). Distribution bar
  mantém-se no topo com altura `h-3` em mobile (mais fácil de
  tocar).
- `lg+`: grid 320 px + 1fr como descrito em §9.1.
- `max-w-6xl` mantido (consistência com o resto dos ecrãs).

A preparação para o **dark mode** (§14 do UIX_DESIGN) está
garantida por construção: todas as cores vêm de tokens, nenhuma
hex hardcoded nos componentes.

## 10. Integração com o sync orchestrator

Este capítulo mostra onde o pipeline actual (`syncOrchestrator.js`)
tem de mexer para consumir o sistema dos capítulos 3–5. É uma
mudança cirúrgica: duas linhas no arranque do sync, uma linha no
loop por email, zero na estrutura. Nenhuma nova passagem no IMAP,
nenhum write novo obrigatório.

### 10.1 Ponto de entrada actual

Hoje o orchestrator faz, por `run`, um único carregamento das
categorias globais (`syncOrchestrator.js:252-262`) e chama
`assignCategoryFromList(entity, categoriesCache)` no loop por
email (`:334`). É um `O(1)` por sync (load uma vez) + `O(N·M)`
por email (substring scan sobre as entidades de cada categoria)
— a baseline que o capítulo 5 já caracterizou.

### 10.2 O que muda

Duas alterações, ambas dentro de `syncOrchestrator.js`:

**1. Arranque do run — carregar overrides a par das categorias.**

```javascript
// Categories are loaded ONCE per run and reused for every email.
let categoriesCache = [];
let overridesCache = [];
try {
  [categoriesCache, overridesCache] = await Promise.all([
    Category.find().lean(),
    CategoryOverride.find({ user_id: config.user_id }).lean(),
  ]);
} catch (e) {
  console.warn(`syncEmails: could not load categories/overrides: ${e.message}`);
  // Proceed with empty caches — every expense ends up with
  // category_id = null instead of an auto-assigned category.
}
```

- **Uma única query adicional por run**, paralelizada com a que
  já existe. Mantém o `O(1)` actual — não vira N+1.
- **Filtro por `user_id`.** O orchestrator corre sempre no
  contexto de um `CurveConfig`, que já tem `user_id`. Carregar
  os overrides de outro user seria um leak (§3.6, §7.3).
- **Fallback gracioso.** Se a `find` de overrides falhar, o run
  continua com `overridesCache = []` e o resolver comporta-se
  como se o user não tivesse regras pessoais — degrada para o
  comportamento pré-overrides, não quebra.

**2. Loop por email — chamar `resolveCategory`.**

```javascript
// ---- 2. Categorise ----
const category_id = resolveCategory(parsed.entity, {
  globalCategories: categoriesCache,
  overrides: overridesCache,
});
```

- Substituição directa de `assignCategoryFromList(parsed.entity,
  categoriesCache)` na linha 334.
- `resolveCategory` é a função implementada no §5.3 — recebe
  entity raw, normaliza, corre o matching cache-aware e devolve
  `category_id` (ObjectId) ou `null`.
- **Prioridade dos overrides é enforced pelo resolver**, não
  pelo orchestrator. O orchestrator não sabe nem precisa de
  saber que a hierarquia existe.

### 10.3 Precedência e "personal is sacred"

A invariante do §6.2 ("personal is sacred") materializa-se aqui
por construção:

- Quando o sync corre para o user A, só os overrides de A estão
  no `overridesCache`. O resolver só considera esses.
- Se A tem `override(lidl → Coffee)` e B não tem, o run do A
  atribui `Coffee`, o run do B atribui `Groceries` (catálogo
  global). Nenhum dos dois runs cruza o outro.
- Isto é **inerentemente** paralelizável por user — o orchestrator
  já corre um run por `CurveConfig` de cada vez
  (§EmailScheduler), e cada run vê apenas o seu próprio
  `overridesCache`.

### 10.4 Impacto em performance

Medição aproximada (os números do §5.5 já são baseline):

| Métrica | Antes | Depois | Delta |
|---------|-------|--------|-------|
| Queries por run (carga inicial) | 1 (`Category.find`) | 2 (+`CategoryOverride.find`) | +1, paralelizada |
| Matching por email | O(N·M) substring | O(O + N·M) resolver | +O — tipicamente ≤ 20 |
| Memória do cache por run | ~N cats | ~N cats + ~O overrides | +O |
| Writes novos | — | — | — |

`N` = nº de categorias globais (≤ 30 em prática), `M` = média
de entidades por categoria, `O` = nº de overrides do user (≤
algumas dezenas). Nenhum destes números tem escala suficiente
para mudar a ordem de grandeza do run.

Não há aumento no número de round-trips IMAP, nem no número de
writes ao Mongo — os únicos writes continuam a ser `Expense.create`
no success path e `CurveLog.create` via `writeLog()`.

### 10.5 Auditoria e logs

O `writeLog({ status: 'ok', ... })` do path de sucesso não muda.
O `category_id` resolvido fica no documento `Expense` e é
linkado pelo `CurveLogsPage` através do expense, não de um
campo novo no log. Não é preciso inventar `status: 'categorised'`
— a informação já está acessível pela cadeia
`curve_logs → expense → category`.

Dois casos onde faz sentido adicionar detail ao log:

- **Match por override (ciclo normal).** `detail: "override →
  <category_name>"` num log `ok` facilita debug de "porque é
  que esta despesa caiu em Coffee?". Campo opcional,
  truncado a 120 chars pelo `truncateDetail` existente.
- **No match (fallback `null`).** Hoje uma despesa sem match
  fica com `category_id = null` silenciosamente. Propõe-se
  acrescentar um flag `uncategorised: true` ao log `ok`
  correspondente, para o `/curve/logs` conseguir filtrar e
  mostrar "N despesas sem categoria este ciclo — adiciona uma
  regra".

Ambos são *opcionais* para o rollout inicial — o pipeline
funciona sem eles. O catálogo completo de `action` values novos
que **são** obrigatórios (apply-to-all, CRUD de categorias,
CRUD de overrides, quick-edit) está consolidado no §13.2 — este
capítulo só cobre as anotações ao sync path já existente, não os
eventos administrativos.

### 10.6 Backwards-compat e shape idêntico

Se o user **não tem overrides** e o catálogo global não foi
alterado, o comportamento é **bit-a-bit idêntico** ao actual.
Isto é garantido pela regra do §5.3: quando `overridesCache`
está vazio, o resolver salta directamente para o matching global
com a mesma semântica do `assignCategoryFromList` de hoje (com
a única diferença "correcta" de ser agora normalised — ver
§5.2). Para o user típico do MVP, o upgrade é invisível até ele
criar a primeira regra.

A função `assignCategoryFromList` pode permanecer exportada
durante a fase 1 do rollout (§11) como shim que chama
`resolveCategory` com `overrides: []` — remove-se na fase 2.

### 10.7 Testes a acrescentar

- **Unit.** `resolveCategory` já tem bateria própria (§5.6). Aqui
  basta um teste de integração que monta um `CurveConfig` fake +
  1 override + 1 email fixture e verifica que a `Expense` criada
  aponta para a categoria do override, não para a global.
- **Regressão.** Correr a suite de fixtures existente sem
  overrides e garantir que os `category_id` resultantes são
  idênticos aos do baseline actual (snapshot).
- **Fallback.** Forçar a `find` de overrides a falhar (mock
  throw) e confirmar que o run termina com sucesso, categorias
  globais a funcionar, e 1 linha de warning no console.

## 11. Compatibilidade com Embers e plano de faseamento

Todas as decisões dos capítulos 3–10 foram tomadas sob a
restrição "o Embers continua a funcionar unchanged". Este
capítulo consolida as garantias dessa compatibilidade, lista as
mudanças que o `CLAUDE.md` tem de reflectir, e propõe uma ordem
de rollout fase-a-fase com pontos de reversão explícitos.

### 11.1 Garantias de compatibilidade com Embers

**Schemas partilhados — zero alterações.**

- `categories` mantém exactamente os campos do
  `docs/embers-reference/models/category.rb`: `name`, `entities`,
  `icon`, `created_at`, `updated_at`. Os capítulos 4–8 só tocam
  estes campos — o `entities[]` é manipulado pelos endpoints
  granulares do §8.3 mas continua a ser um array simples de
  strings que o Mongoid consegue ler.
- `expenses` mantém schema literal. A **única** relaxação é
  operacional (§4.4): Curve Sync passa a poder UPDATE o campo
  `category_id`, e só esse campo, via o helper
  `reassignCategoryBulk`. O `before_create :assign_category` do
  Embers (`docs/embers-reference/models/expense.rb:23`) continua
  a correr para despesas criadas do lado Embers, usando o
  `Category.where(:entities.in => [entity]).first` original.
- `users` continua com as regras de `CLAUDE.md §MongoDB Collection
  Access Rules`: Curve Sync nunca promove/despromove `role`, o
  "last admin" guard é exclusivo de Embers.

**Nova colecção — invisível ao Embers.**

- `curve_category_overrides` vive no mesmo DB mas tem prefixo
  `curve_*` (consistente com `curve_configs` e `curve_logs`). O
  Embers não tem Mongoid model para este nome, portanto nunca a
  lê nem escreve. Se alguém abrir a Rails console, a colecção
  aparece no `show collections` mas não quebra nada.
- A colecção só tem refs para `users` e `categories` — não cria
  dependências cíclicas.

**Leituras do Embers — resultado imutável.**

- Se um user abrir o Embers e listar as suas despesas, a lista
  continua idêntica. O `category_id` pode ter mudado (porque o
  Curve Sync fez apply-to-all), mas o Embers só consome
  `category_id → category.name`, que continua válido. Não há
  campos novos, não há valores fora dos enums existentes.
- O `category.total_spent` do Embers
  (`docs/embers-reference/models/category.rb:19`) continua a
  somar todas as expenses com aquele `category_id`, indiferente
  a se a atribuição veio de um override ou do catálogo global.

**Escritas do Embers — não afectadas.**

- Se o user criar uma `Expense` pelo Embers admin UI, o
  `before_create` dele corre como hoje. Os overrides pessoais
  do Curve Sync **não se aplicam** a essa escrita — o Embers não
  os conhece. Isto é aceitável: o caminho primário de criação é
  o sync automático, que passa sempre pelo `syncOrchestrator` do
  Curve Sync e portanto pelo resolver novo (§10).
- Se um admin adicionar uma categoria global pelo Embers, o
  Curve Sync apanha-a no próximo run (o `Category.find()` do
  §10.2 é sempre fresh).

### 11.2 Mudanças no `CLAUDE.md`

Três blocos a actualizar no `CLAUDE.md` (a fazer em commit
separado, ver §11.4):

**1. §MongoDB Collection Access Rules.** Reformular `categories`
e `expenses`, adicionar `curve_category_overrides`:

```
- `categories` — READ + UPDATE (scoped to admin CRUD flows). Owned
  by Curve Sync from the category-management screen forward;
  Embers keeps read-compat. Never rename/remove fields.
- `expenses` — READ + INSERT + UPDATE of `category_id` ONLY.
  Other fields remain INSERT-only. UPDATEs go through the
  `reassignCategoryBulk` helper, never raw `Expense.updateOne`
  from route handlers.
- `curve_category_overrides` — Full CRUD (owned by Curve Sync,
  per-user category matching rules).
```

**2. §Architecture.** Uma linha curta a referenciar
`docs/Categories.md` como fonte canónica: "Category management,
matching, and overrides: see `docs/Categories.md` (single source
of truth for the two-tier model)."

**3. §Project Structure.** Listar os novos ficheiros esperados:
`server/src/models/CategoryOverride.js`, `server/src/routes/
categoryOverrides.js`, `server/src/middleware/requireAdmin.js`,
`server/src/services/categoryResolver.js`,
`client/src/pages/CategoriesPage.jsx`, `client/src/hooks/
useCountUp.js`.

### 11.3 Faseamento (roadmap)

Sete fases, cada uma entregável e reversível em isolamento. A
ordem é optimizada para **minimizar risco no Embers**: primeiro
mexe-se só em colecções exclusivas de Curve Sync, só depois se
toca na relaxação de `expenses`.

**Fase 0 — Preparação (docs + schema).**
- Este documento (já escrito).
- Actualizar `CLAUDE.md` (§11.2).
- Criar o model `CategoryOverride` (§4.3) com os índices, sem
  ainda usar.
- PR pequeno, merge rápido. **Reversível:** `git revert`.

**Fase 1 — Backend do resolver + CRUD de overrides.**
- Implementar `services/categoryResolver.js` (§5) com unit tests.
- Implementar `routes/categoryOverrides.js` (§8.4) com os 4
  CRUD endpoints + autocomplete tests.
- **Não integrar ainda no orchestrator.** O código novo vive em
  paralelo mas ninguém o chama.
- **Reversível:** as rotas novas podem ser desligadas no
  `server/src/index.js` sem tocar no orchestrator.

**Fase 2 — Integração no sync orchestrator.**
- Alterar `syncOrchestrator.js` nas duas linhas do §10.2.
- Manter `assignCategoryFromList` como shim que chama
  `resolveCategory(entity, { overrides: [], globalCategories })`
  — garantia de backwards-compat bit-a-bit para users sem
  overrides (§10.6).
- Correr a suite de fixtures para confirmar snapshots
  idênticos.
- **Reversível:** reverter o commit volta ao comportamento antigo.

**Fase 3 — CRUD admin de categorias globais.**
- Implementar `routes/categories.js` completo (§8.2, §8.3) com
  `requireAdmin` middleware (§7.2).
- Aqui começa o write path sobre `categories` — é a primeira
  fase com impacto no schema partilhado. A mitigação é que as
  escritas continuam a ser `{ name, entities, icon }`, sem
  campos novos.
- **Reversível:** desligar rotas, fica com o `GET /` actual.

**Fase 4 — Ecrã de gestão (modo user primeiro).**
- `CategoriesPage.jsx` (§9) em modo user: visualização, CRUD de
  overrides pessoais, sem mexer no catálogo global. Inclui toda
  a camada motion & grafismo do §9.8.
- **Reversível:** remover a rota do `App.jsx` e o link da
  sidebar.

**Fase 5 — Ecrã de gestão (modo admin).**
- Adicionar ao mesmo componente o modo admin (§9.9): botão `+
  Categoria`, edição directa de nome/ícone, CRUD de entidades
  globais.
- Lançar apenas para o admin único do MVP antes de considerar
  multi-admin.
- **Reversível:** flag `enableAdminCategoryEditing` no frontend
  ou hide do botão, sem remover código.

**Fase 6 — Apply-to-all + quick-edit inline (endpoint + UX).**
- Primeira fase que **requer** a relaxação do §4.4 (UPDATE de
  `category_id` em `expenses`). Implementar `reassignCategoryBulk`
  em `services/expense.js`, os dois endpoints do §8.5, e o modal
  de confirmação do §9.7.
- Três sub-entregáveis:
  - **6a.** `reassignCategoryBulk` + endpoints de apply-to-all do
    §8.5 — usado pelo ecrã `/categories` (§9.7).
  - **6b.** `PUT /api/expenses/:id/category` do §8.7 — endpoint
    único, reutiliza o mesmo helper com filtro `{ _id, user_id }`.
  - **6c.** Componente `<CategoryPickerPopover>` + integração nas
    tabelas `/expenses` e `/` (dashboard) — capítulo 12 inteiro.
    Inclui o modal de confirmação reutilizável
    `<ConfirmDialog>` para o opt-in entity-wide.
- Testar exaustivamente com `dry_run: true` antes de ligar o
  flag escrita.
- **Reversível, mas com asterisco:** um apply-to-all já
  executado é reversível só via novo apply-to-all (não há
  undo no MVP — ver §6.5). Um `git revert` para o código,
  sim, trivial. O sub-entregável 6c é extra-reversível: basta
  remover o `onClick` do chip para voltar ao comportamento
  read-only actual, sem tocar no backend.

**Fase 7 — Polimento e observabilidade.**
- Campo `detail: "override → <name>"` nos logs `ok` (§10.5).
- Flag `uncategorised: true` nos logs para o filtro do
  `/curve/logs`.
- Métricas no dashboard: "N overrides activos" como stat card
  opcional.
- Seed script (opcional) de entidades comuns portuguesas
  (Continente, Lidl, Pingo Doce, Auchan, Mercadona, Galp, BP,
  Repsol, MBWay, Via Verde) no catálogo global — acelera a
  experiência de onboarding sem obrigar o admin a escrever
  tudo à mão.

### 11.4 Riscos e mitigação

| Risco | Impacto | Mitigação |
|-------|---------|-----------|
| Race entre admin `POST /categories` e user `POST /category-overrides` com o mesmo pattern | Override aponta para categoria eliminada | Índices únicos (§4.3) + handlers fazem re-read do `category_id` antes de aceitar. `404 category_not_found` no handler do override se a categoria já não existir. |
| Apply-to-all parcialmente aplicado (falha a meio) | Despesas de um user com `category_id` inconsistente | Operação é `updateMany` único no Mongo — atómica ao nível do documento. Se falhar, falha globalmente e a transacção é audit-logged (§6.4). Mongo 4.4+ single-collection writes são idempotentes para este shape. |
| Admin elimina uma categoria com overrides pendentes | Overrides órfãos | `DELETE /api/categories/:id` bloqueia com `409 category_in_use` e devolve contadores (§8.2). Admin tem de resolver antes. |
| Matching com um dataset grande degrada | Sync lento para users com muitos overrides | Caps práticos: ≤ 30 categorias globais, ≤ dezenas de overrides/user. §5.5 já cobre a análise. Se alguém exceder, o resolver ainda é linear — 600 comparações em memória são microssegundos. |
| Frontend quebra num cliente que já abriu a app antes do backend ter migrado | Telefone aberto no dashboard antes da Fase 4 | Não se aplica — o ecrã de categorias é *novo*, não substitui nenhum existente. `GET /api/categories` (leitura, já existe) mantém-se compat. |
| Admin cria override para si próprio por engano no ecrã admin | Confusão cognitiva | O modo admin e o CRUD de overrides pessoais vivem em zonas visualmente distintas (§9.9). Ambos requerem confirmação em acções destrutivas. |
| Embers cria uma categoria nova enquanto o Curve Sync corre um sync | Cache stale durante um run | Aceitável — o próximo run apanha. Cache é refrescado a cada run (§10.2). |
| `prefers-reduced-motion` não respeitado num browser antigo | UX degradada, não quebra | Fallback CSS é defensivo (`animation: none !important`). O count-up hook tem detecção runtime via `matchMedia`. |

### 11.5 Rollback plan

Três níveis de rollback, do mais granular para o mais drástico:

1. **Feature flag no frontend.** Esconder o link de `/categories`
   na sidebar. Os endpoints novos continuam a existir mas
   ninguém os chama da UI. Zero-risk rollback visual.
2. **Desligar rotas no backend.** Comentar `app.use('/api/
   category-overrides', ...)` e `app.use('/api/categories',
   categoriesAdminRouter)` em `server/src/index.js`. Mantém a
   rota de leitura original. Overrides no DB ficam intactos.
3. **Reverter o sync orchestrator.** `git revert` do commit da
   Fase 2. O resolver volta a ser `assignCategoryFromList`. Os
   overrides existentes em DB passam a ser ignorados (sem
   perda — permanecem guardados; basta re-aplicar o commit).

Nenhum destes rollbacks requer migração de dados, escrita ao
Mongo, ou coordenação com o Embers. O design é propositadamente
aditivo: todas as estruturas novas vivem em colecções exclusivas
ou em campos já existentes, e a única operação destrutiva
(apply-to-all) tem um audit trail em `curve_logs` que permite
reconstruir o estado anterior manualmente se for preciso.

### 11.6 Critérios de "done"

O projecto considera-se entregue quando:

- [ ] Embers continua a ler/escrever `categories` e `expenses`
      exactamente como antes (smoke test manual com a Rails
      console).
- [ ] Um user sem overrides tem o sync com resultados
      idênticos ao baseline (snapshot test).
- [ ] Um user com override pessoal vê a despesa cair na sua
      categoria escolhida, enquanto outro user na mesma
      instalação vê a sua cair no catálogo global (integration
      test).
- [ ] Apply-to-all com `dry_run: true` é idempotente e observável
      no `/curve/logs`.
- [ ] O ecrã `/categories` carrega em < 500 ms para ~20
      categorias e ~100 entidades (perf budget).
- [ ] `prefers-reduced-motion: reduce` remove **todas** as
      animações (manual QA).
- [ ] `CLAUDE.md` reflecte as mudanças do §11.2 e aponta para
      este documento como canonical.

Com estas caixinhas todas marcadas, o sistema de categorização
redesenhado substitui em pleno o `assign_category` original do
Embers sem exigir nenhuma alteração ao lado Embers — e abre a
porta às melhorias opcionais (detalhe nos logs, métricas no
dashboard, undo de apply-to-all) que ficaram conscientemente
fora do MVP.

## 12. Quick edit inline nas tabelas de despesas

O capítulo 9 desenhou o ecrã `/categories` como o local certo para
gerir *regras* (catálogo global, overrides pessoais, catálogos de
entidades). Este capítulo cobre um caso adjacente: o user está a
olhar para uma despesa concreta e quer **corrigir a categoria de
*essa* despesa** sem sair da tabela, sem criar regras, sem efeito
colateral nas outras despesas. É o "quick edit sem dor" que tira
atrito do dia-a-dia.

Duas tabelas recebem o mesmo componente:

- `/expenses` — tabela paginada (`ExpensesPage.jsx:87-110`), coluna
  "Categoria" com o chip neutro `badge bg-sand-100 text-sand-600`.
- `/` (dashboard) — tabela "Despesas recentes"
  (`DashboardPage.jsx:265-269`), mesmo chip, mesma estrutura.

### 12.1 Princípios

1. **O chip é o trigger.** Click no chip da categoria abre o
   popover na mesma célula. Nenhum botão extra, nenhum menu
   contextual, nenhuma navegação.
2. **O default é inofensivo.** A acção-padrão afecta **apenas**
   aquela despesa. O caminho destrutivo (aplicar a tudo) exige
   opt-in explícito + confirmação.
3. **Reutiliza o modelo existente.** Nada de novas colecções. A
   operação sozinha usa a relaxação do §4.4; o modo entity-wide
   reutiliza overrides (§4.3) + apply-to-all (§6 / §8.5).
4. **Um só componente.** `<CategoryPickerPopover>` vive em
   `client/src/components/common/` e é consumido pelas duas
   tabelas com as mesmas props. Consistência visual e uma única
   superfície para testar.

### 12.2 Anatomia do popover

```
┌─ Alterar categoria ──────────────────── [×] ┐
│                                              │
│   > Procurar...                              │
│                                              │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐        │
│  │ 🛒   │ │ ☕   │ │ 🏠   │ │ ⛽   │        │
│  │Grocs │ │Coffe │ │Home  │ │Fuel  │        │
│  └──────┘ └──────┘ └──────┘ └──────┘        │
│  ┌──────┐ ┌──────┐ ┌──────┐                 │
│  │ 💪   │ │ 🎬   │ │ ...  │                 │
│  │Gym   │ │Media │ │      │                 │
│  └──────┘ └──────┘ └──────┘                 │
│                                              │
│  ☐ Aplicar a todas as despesas de "Lidl"    │
│                                              │
│          [ Cancelar ]  [ Guardar ]           │
└──────────────────────────────────────────────┘
```

- **Positioning.** Floating panel ancorado na célula do chip
  (`position: absolute` com `right-0 top-full mt-2`), largura
  `w-80`, sombra `shadow-lg`, `rounded-2xl`, `bg-white`, `border
  border-sand-200`. Z-index acima das linhas da tabela.
- **Dismiss.** Click fora, `Escape`, ou botão `×` fecha sem
  guardar. Mudança pendente volta ao estado inicial.
- **Focus trap.** `useEffect` foca o input de search ao abrir;
  `Tab` cicla entre search → grid → checkbox → botões → `×`.
- **Search.** Filtro client-side instantâneo sobre
  `category.name` (o catálogo chega pré-carregado via
  `GET /api/categories` no mount da página; sem round-trip extra).

### 12.3 Grid de chips (colorido e iconográfico)

Cada chip é um botão `rounded-xl` com:

- **Ícone no topo.** Emoji ou SVG do §9.4 (o upload de ícone do
  admin alimenta ambos). Fallback: inicial maiúscula da
  categoria num círculo.
- **Cor de fundo.** `bg-{category.color}/10` + `border
  border-{category.color}/30`. A cor vem do swatch definido em
  §9.3 — admin pode escolher, default gerado por hash estável
  sobre `category.name` para já existir sem configuração
  adicional.
- **Nome.** `text-xs font-medium text-sand-900`, máximo 2 linhas
  com `line-clamp-2`.
- **Estado seleccionado.** `ring-2 ring-curve-500` + `bg-curve-50`
  — o chip da categoria actual aparece pré-seleccionado ao abrir.
- **Hover/active.** `hover:bg-{color}/20 active:scale-[0.97]`
  consistente com o resto dos botões do design system (§5.3 do
  UIX_DESIGN).

Layout `grid grid-cols-4 gap-2`. Se o user tiver >12 categorias,
aparece scroll vertical interno (`max-h-64 overflow-y-auto`) —
raro em prática (§5.5 assume ≤ 30 categorias globais).

### 12.4 Default: afectar só esta despesa

Fluxo "inofensivo" (checkbox **desligado**, estado inicial):

1. User clica `Guardar` com uma categoria diferente seleccionada.
2. Frontend chama `PUT /api/expenses/:id/category` com
   `{ category_id }`.
3. Backend valida: `user_id === req.userId`, `category_id`
   existe no catálogo global, e emite um `reassignCategoryBulk(
   { _id, user_id }, category_id)` — a mesma função autorizada
   do §4.4, mas com filtro de uma única despesa.
4. Response `200 { data: Expense }` com o documento actualizado.
5. Frontend faz optimistic update (chip muda instantaneamente)
   com rollback em caso de erro. Toast de sucesso
   `slide-in-right` "Categoria actualizada".

**Garantias:**

- Nenhum override é criado. As próximas despesas com a mesma
  entidade continuam a seguir as regras actuais (catálogo global
  ou override pessoal, se já existir).
- A despesa fica com `updated_at` actualizado (§4.4) — audit
  trail natural.
- Qualquer edição posterior pelo mesmo ou outro path (ex.: novo
  apply-to-all global) pode reescrever esse `category_id`. Não
  há "pin" do user para "eu já editei isto, não mexam". Isto é
  intencional: o user que quiser persistência cria um override
  pessoal via §9 ou activa o checkbox do §12.5.

### 12.5 Opt-in: aplicar entity-wide

Fluxo destrutivo (checkbox **ligado**). A label do checkbox
mostra a entidade exacta da despesa em contexto:

> ☐ Aplicar a todas as despesas de **"Lidl"**

Isto elimina ambiguidade: o user vê exactamente qual a string
que vai ser usada como pattern. Nenhum match fuzzy, nenhuma
surpresa.

**Fluxo:**

1. User marca o checkbox e clica `Guardar`.
2. Frontend abre um **segundo modal** de confirmação (não um
   simples `confirm()`) com:

```
┌─ Confirmar alteração em massa ─────────────┐
│                                             │
│  Vais alterar a categoria de todas as      │
│  despesas passadas e futuras com entidade  │
│  "Lidl" de Groceries para Coffee.          │
│                                             │
│  → 42 despesas vão ser re-catalogadas      │
│  → Novas despesas futuras com "Lidl"       │
│     serão automaticamente Coffee            │
│                                             │
│  Esta acção é reversível manualmente,      │
│  criando outra regra ou editando este      │
│  override em /categories.                   │
│                                             │
│    [ Voltar atrás ]    [ Sim, aplicar ]    │
└─────────────────────────────────────────────┘
```

3. O preview (`42 despesas`) vem de uma chamada prévia a `POST
   /api/category-overrides/preview` com `{ pattern: entity,
   match_type: 'exact', category_id }`, ou então a criação do
   override com `dry_run: true` no apply-to-all. O número aparece
   antes do user confirmar, para não comprometer a regra sem
   visibilidade de impacto.
4. Se o user confirmar, o frontend faz **duas chamadas
   sequenciais**:
   a) `POST /api/category-overrides` upsert com `{ pattern:
      entity, match_type: 'exact', category_id }`. Se já existe
      override para essa entidade (§4.3 índice único), faz
      `PUT` em vez de `POST`.
   b) `POST /api/category-overrides/:id/apply-to-all` com
      `{ scope: 'affected', dry_run: false }`.
5. Response final re-puxa a página actual (`GET /api/expenses`)
   para reflectir os 42 `category_id` novos.
6. Toast de sucesso `"42 despesas re-catalogadas"`.

**Porquê duas chamadas em vez de um endpoint combinado.** A API
do §8 já expõe tudo o que é preciso; criar um endpoint
`/expenses/:id/category-apply-all` duplica lógica. O custo de
dois round-trips (< 300 ms no total) é invisível por trás do
spinner do modal. Se no futuro ficar lento (improvável), o
endpoint combinado é um refactor pequeno.

### 12.6 Integração com a hierarquia (§3, §5)

O entity-wide cria sempre um **override pessoal** (tabela
`curve_category_overrides`), nunca mexe no catálogo global. Isto
é coerente com o §7.3:

- User não-admin escolhe `Lidl = Coffee` apenas para si.
- Admin que use o quick-edit também cria um **override pessoal
  para si** — editar o catálogo global requer ir ao ecrã
  `/categories` em modo admin (§9.9). Garantia importante:
  editar uma despesa no dashboard nunca afecta outros users por
  engano, mesmo como admin.

Se o user já tinha um override para essa entidade a apontar para
outra categoria, o upsert do §12.5(4a) **sobrescreve** o destino.
Os outros campos (`match_type`, `priority`) mantêm-se. O modal
de confirmação do §12.5 tem de detectar este caso e ajustar a
cópia:

> "Já tens uma regra: **Lidl → Home Improvement**.
> Vais alterá-la para **Lidl → Coffee** e re-catalogar as 42
> despesas afectadas."

### 12.7 API (delta ao §8)

Um endpoint novo, dedicado ao single-expense path:

`PUT /api/expenses/:id/category` — actualiza apenas o
`category_id` da despesa `:id`, enforcando `user_id: req.userId`
no filtro. Body `{ category_id: ObjectId | null }`.

- `200` → `{ data: Expense }` (expense actualizado)
- `400 invalid_category_id` — `category_id` não é um ObjectId válido
- `404 expense_not_found` — inclui o caso cross-user (§7.5, 404
  em vez de 403)
- `404 category_not_found` — `category_id` não existe no catálogo
  global. `null` é aceite (remove associação).

**Não precisa de `requireAdmin`** — qualquer user autenticado
pode editar as suas próprias despesas (§7.3 permissions matrix
ganha uma linha adicional para esta rota).

Os restantes endpoints (create/upsert override + apply-to-all)
reutilizam exactamente o shape do §8.4 e §8.5 sem delta.

### 12.8 UIX — motion & feedback

Consistente com o §9.8 e com `UIX_DESIGN.md §4`:

- **Abertura do popover.** `fade-in` 200 ms + `translateY(-8px)`
  → 0. Curto, subtil, não distrai a tabela por baixo.
- **Grid de chips.** Stagger `animationDelay: i * 30ms` (mais
  rápido que o stagger da lista do §9.3 — o popover é pequeno
  e não deve demorar).
- **Chip seleccionado.** `ring-2 ring-curve-500` aparece
  instantâneo, sem animação — é feedback, não decoração.
- **Botão Guardar em loading.** Spinner `animate-spin` +
  texto `"A guardar..."` (consistência com §10 do UIX_DESIGN).
- **Optimistic update no chip da tabela.** O chip muda
  imediatamente na célula da tabela mal o popover feche, antes
  da response confirmar. Em caso de erro 4xx/5xx, `fade-out` +
  rollback + toast de erro `bg-red-50 text-curve-700`.
- **Confirmação entity-wide.** Modal central com `fade-in` +
  `scale-95 → scale-100` em 250 ms. Backdrop `bg-sand-950/40`.
  Idêntico ao modal de apply-to-all do §9.7 — mesmo componente
  reutilizável, `<ConfirmDialog>`.

### 12.9 Empty states e edge cases

- **Despesa sem categoria (`category_id = null`).** O chip
  aparece como `—` cinzento (`text-sand-300`). Click no `—`
  abre o popover na mesma — é o caminho natural para atribuir
  manualmente uma despesa "uncategorised" (§10.5).
- **User sem categorias criadas.** Grid mostra empty state
  `"Sem categorias — pede ao admin para criar."`. Não permite
  guardar. Raro após seed inicial (§11.3 Fase 7).
- **Mesma categoria seleccionada + `Guardar`.** Botão fica
  disabled enquanto `selection === exp.category_id` e o
  checkbox está desligado. Evita chamadas no-op ao backend.
- **Race com sync automático.** Se um sync correr entre o open
  e o save do popover e a despesa for re-catalogada, o save do
  user ganha (é mais recente) — `updated_at` reflecte o último
  write. Aceitável: o user escolheu explicitamente.
- **Despesa apagada do outro lado.** Cenário impossível hoje
  (Curve Sync nunca apaga, §4.4). Se Embers vier a apagar, o
  `PUT` devolve `404 expense_not_found` e a linha desaparece no
  próximo refresh da tabela.

### 12.10 Posição no roadmap

Encaixa na **Fase 6** do §11.3 (apply-to-all + relaxação do
§4.4) como sub-entregável:

- **6a.** `reassignCategoryBulk` + endpoints de apply-to-all
  (§8.5) — já previsto.
- **6b.** `PUT /api/expenses/:id/category` (§12.7) — adição
  pequena, reutiliza o mesmo helper.
- **6c.** Componente `<CategoryPickerPopover>` + integração nas
  tabelas `/expenses` e `/` — frontend isolado, flag friendly.

A Fase 6 continua reversível como está descrito em §11.5: desligar
o popover do frontend é um rollback de uma linha (remover o
`onClick` do chip). O endpoint novo pode ser desligado em
`server/src/index.js` sem efeitos colaterais.

### 12.11 Testes a acrescentar

- **Unit.** `PUT /api/expenses/:id/category` com user_id válido
  (200), user_id cross (404), category_id inválido (404), null
  (200 com `category_id = null`).
- **Integration.** Quick-edit single-expense numa despesa, abrir
  outra página, confirmar que só uma linha mudou e as restantes
  Lidl continuam em Groceries.
- **Integration.** Quick-edit com checkbox ligado cria override,
  corre apply-to-all, confirma contadores e verifica que as
  despesas de *outros* users não são tocadas (§12.6).
- **Visual.** Snapshot do popover com 4 categorias e com 20
  categorias (scroll interno), com e sem category actual
  seleccionada.
- **A11y.** Navegação por teclado completa (Tab/Enter/Escape)
  no popover e no modal de confirmação, focus trap ao abrir,
  focus restore ao fechar (volta ao chip clicado).

### 12.12 Batch-move multi-select em `/expenses`

O quick-edit §12.2-§12.4 resolve uma despesa de cada vez, o que
é insuficiente quando o user volta de umas férias e tem 30
*"Hsn Store Com"* por catalogar. Esta secção descreve o modo
multi-select, que reutiliza o mesmo `<CategoryPickerPopover>` do
§12.2 com um pequeno delta de props: `context={ kind: 'bulk',
count: N }`.

**Superfície.** Apenas a `/expenses` (a tabela do dashboard é
pequena e nunca precisará disto). Não é admin-only — qualquer
user autenticado pode fazer batch-move das suas próprias
despesas. O cap duro é `500 ids/chamada` (espelhado no server
§8.7 e no client `BULK_MAX = 500`).

**Interacção.** Pattern Gmail-style, em três camadas:

1. **Checkbox em cada linha.** Click → adiciona/remove do
   selection set. Shift-click → selecciona o intervalo entre o
   último anchor e o click actual (range-select clássico).
2. **Master checkbox no header.** Estados: vazio → tudo na página
   seleccionado; *intermediate* → algumas da página (indicado
   via `el.indeterminate = true` no ref callback); tudo na
   página → clear. Escopo = *página visível*, não o filtro
   inteiro — isso é a camada 3.
3. **"Seleccionar todas as N" (hint banner).** Quando a página
   inteira está seleccionada **e** `total > page.length`,
   aparece um link inline:
   - `total <= 500` → `"Seleccionar todas as N despesas"` (um
     click → `GET /api/expenses?fields=_id&…` (§8.7) devolve
     até 500 ids do filtro actual, substitui o selection set).
   - `total > 500` → `"Mais de 500 despesas — refina o filtro"`
     (warning, sem link — o user tem de apertar o filtro antes
     de continuar). Este é o guardrail de UX; o guardrail
     final é o `400 bulk_too_large` do servidor.

**Action bar.** Sticky na zona acima da tabela quando
`selection.size > 0`:

```
┌────────────────────────────────────────────────┐
│  12 seleccionadas     [ Limpar ]  [ Mover → ]  │
└────────────────────────────────────────────────┘
```

O botão primário `Mover →` (com as mesmas variantes de §12.2:
`btn-primary`, `active:scale-[0.97]`) ancora o
`<CategoryPickerPopover>` em modo bulk:

- Título passa a `"Mover N despesa(s) para…"` (pluralização
  pt-PT: 1 → "1 despesa", N → "N despesas").
- Nenhum chip tem `ring-curve-500` de "current" — a selecção é
  tipicamente mista e um highlight seria mentira.
- O guard `clicked === current` do single-mode é desligado — no
  modo bulk qualquer click é um write, e o server reporta
  honestamente no `skipped` quantas já estavam na target.
- `"Sem categoria"` continua disponível como row explícita
  (é o mesmo caminho do §12.9).

**Write path.** O click no chip dispara
`PUT /api/expenses/bulk-category` (§8.7) com o set completo de
ids. O client aplica update optimista — snapshot das rows
afectadas, reassigna `category_id` localmente, e rollback via
rehidratação do snapshot em caso de erro 4xx/5xx. Toast com
contagem:

- Sucesso → `"N despesa(s) movida(s) para <target>"` (mais
  `" (M saltadas)"` se `skipped > 0`).
- Erro → `"Falhou mover despesas: <msg>"` + rollback automático.

**Interacção com o quick-edit single-row.** Quando
`selection.size > 0`, o chip de cada linha fica `disabled` (não
abre o popover single-mode) — duas superfícies de escrita a
competir pela mesma célula seria confuso. Limpar a selecção (`×`
ou `Limpar`) reactiva o quick-edit.

**Auditoria.** Uma única linha `expense_category_changed_bulk`
por chamada, **não N linhas**. Ver §13.2 #36.

### 12.13 Testes a acrescentar — batch-move

- **Unit.** `PUT /api/expenses/bulk-category` com ids válidos
  (200 com `moved`, `skipped`, `target_category_name`), ids
  vazios (`400 invalid_body`), 501 ids (`400 invalid_body`),
  `category_id` inexistente (`404 category_not_found`), ids
  cross-user (silenciosamente em `skipped`, nada vaza).
- **Unit.** `GET /api/expenses?fields=_id` devolve `{ ids,
  total }` e falha com `400 bulk_too_large` quando `total > 500`.
- **Integration.** Seleccionar 3 linhas + mover, verificar que
  `expense_category_changed_bulk` é **uma** row de log com
  `target=…` e `count=3` no `error_detail`.
- **Integration.** Seleccionar via "Seleccionar todas as 24"
  (`total <= 500`), mover, verificar que as 24 ficam todas na
  target e o toast diz `"24 despesas movidas"`.
- **A11y.** Master checkbox atinge estado *indeterminate*
  quando parte da página está seleccionada. Shift-click
  funciona em modo teclado (shift + clique no checkbox).

## 13. Auditoria e observabilidade

Os capítulos 6, 7, 10 e 12 mencionam logs em várias situações
(apply-to-all, 403 admin, override → name no `detail`, etc.) mas
de forma dispersa. Este capítulo consolida toda a camada de
auditoria numa única tabela de referência, alinhada com o contrato
já existente em `docs/CURVE_LOGS.md`. O objectivo é triplo: (1)
deixar rasto de qualquer decisão que mude a forma como uma
despesa é categorizada, (2) dar visibilidade ao `/curve/logs`
sobre actos administrativos raros (criar categoria, mover
entidade) sem inventar uma UI nova, e (3) **não introduzir
alterações ao schema do `CurveLog`** — tudo assenta no `action`
enum actual + packing em `error_detail`.

### 13.1 Porquê auditar — e o que justifica o custo

- **Debug.** Quando um user pergunta "porque é que esta despesa
  caiu em Groceries e não em Coffee?", o trail de logs tem de
  permitir reconstruir a cadeia de decisões (que override
  existia, quando foi criado, se houve apply-to-all no meio).
- **Segurança.** Acções admin (criar/apagar categoria, adicionar
  entidade ao catálogo global) afectam todos os users — são
  exactamente as acções que um ataque queria fazer se obtivesse
  escalada de privilégio.
- **Undo futuro.** O §6.10 deixou o undo fora do escopo do MVP.
  Mesmo sem ele ser implementado já, o log tem de guardar o
  suficiente para um admin conseguir reverter manualmente (via
  novo apply-to-all) com base no registo.
- **Ruído controlado.** Nem tudo vale um log — o §13.4 lista o
  que é deliberadamente *não* auditado para evitar poluir o
  `/curve/logs`.

### 13.2 Catálogo de novas `action` — tabela de referência

Estas linhas estendem a tabela do `docs/CURVE_LOGS.md §4`. Todas
as entradas têm `status: 'ok'` excepto se indicado. O formato de
`error_detail` segue a convenção k=v space-separated (mesmo do
`oauth_token_refreshed` existente), tudo passa pelo
`truncateDetail` (120 chars) do `audit.js`.

| # | `action` | Source | `status` | `ip` | `error_detail` content | Canonical pt-PT message |
|---|----------|--------|----------|------|------------------------|-------------------------|
| 23 | `category_created` | `routes/categories.js::POST /` (admin) | `ok` | yes | `name=<name> entity_count=<n>` | `"Categoria criada: <name>"` |
| 24 | `category_updated` | `routes/categories.js::PUT /:id` (admin) | `ok` | yes | `name=<name> changed=<fields>` | `"Categoria actualizada: <name>"` |
| 25 | `category_deleted` | `routes/categories.js::DELETE /:id` (admin) | `ok` | yes | `name=<name> expense_count=<n>` | `"Categoria apagada: <name>"` |
| 26 | `category_entity_added` | `routes/categories.js::POST /:id/entities` (admin) | `ok` | yes | `category=<name> entities=<n>[,<n>…]` | `"Entidades adicionadas a <name>: <lista>"` |
| 27 | `category_entity_removed` | `routes/categories.js::DELETE /:id/entities/:entity` (admin) | `ok` | yes | `category=<name> entity=<value>` | `"Entidade removida de <name>: <value>"` |
| 28 | `category_entity_moved` | bulk move handler (admin) | `ok` | yes | `from=<name> to=<name> count=<n>` | `"Entidades movidas de <from> para <to>"` |
| 29 | `override_created` | `routes/categoryOverrides.js::POST /` (user) | `ok` | yes | `pattern=<value> match_type=<type> category=<name>` | `"Regra pessoal criada: <pattern> → <category>"` |
| 30 | `override_updated` | `routes/categoryOverrides.js::PUT /:id` (user) | `ok` | yes | `pattern=<value> category=<name> changed=<fields>` | `"Regra pessoal actualizada: <pattern> → <category>"` |
| 31 | `override_deleted` | `routes/categoryOverrides.js::DELETE /:id` (user) | `ok` | yes | `pattern=<value> category=<name>` | `"Regra pessoal apagada: <pattern>"` |
| 32 | `apply_to_all` | `routes/categoryOverrides.js::POST /:id/apply-to-all` + admin counterpart | `ok` | yes | `scope=<personal\|platform> target=<override\|category> affected=<n> skipped_personal=<n>` | `"Aplicado a <n> despesas: <pattern> → <category>"` |
| 33 | `apply_to_all_failed` | mesma rota, catch | `error` | yes | `reason=<msg>` | `"Aplicação em massa falhou: <reason>"` |
| 34 | `expense_category_changed` | `routes/expenses.js::PUT /:id/category` (user, §12.7) | `ok` | yes | `expense_id=<id> from=<name> to=<name> entity=<value>` | `"Despesa recategorizada: <entity> → <to>"` |
| 35 | `admin_denied` | `middleware/requireAdmin.js` (§7.2) | `error` | yes | `method=<METHOD> path=<path>` | `"Acesso admin recusado: <method> <path>"` |
| 36 | `expense_category_changed_bulk` | `routes/expenses.js::PUT /bulk-category` (user, §12.12) | `ok` | yes | `target=<name> count=<n> from_mixed=<bool>` | `"N despesa(s) movida(s) para <target>[ (origem mista)]"` |

**Notas sobre a tabela:**

- O index 23 é o seguinte ao último de `CURVE_LOGS.md §4` (#22
  = `first_sync_completed`). Ao adicionar, respeitar a sequência
  para manter a tabela ordenada.
- `category_entity_added` pode receber várias entidades no mesmo
  POST (§8.3 permite `{ entities: [] }`). O `error_detail` lista
  a primeira + contador total para respeitar os 120 chars:
  `category=Groceries entities=lidl,continente,+3`.
- `apply_to_all` **não usa `action: 'apply_to_all_failed'`** no
  caminho de sucesso — só o caminho de erro tem o sufixo
  `_failed`, como já é convenção pelo `audit.js §4.2`.
- `expense_category_changed` é o único evento deste capítulo que
  é **batched no frontend** (§13.5) — cada click no chip do §12
  gera uma linha, mas o `describeLog` agrupa adjacentes do mesmo
  dia para evitar flood.
- `expense_category_changed_bulk` é o **oposto** do anterior: uma
  única chamada a `PUT /bulk-category` (até 500 rows) gera uma
  única linha de log, não N. `entity` fica `null` — a operação
  abrange múltiplas entidades e nenhuma representa o conjunto. A
  flag `from_mixed=true` sinaliza que as rows vinham de mais de
  uma categoria de origem (o renderer acrescenta " (origem
  mista)" ao título). O `describeLog` usa `hideDetail: true` para
  esconder o raw `error_detail` na `/curve/logs` — o título já
  diz tudo.

### 13.3 Schema do CurveLog — zero alterações

Tudo assenta no que já existe:

- **`action`** — adicionar as 14 novas entradas ao enum do
  `server/src/models/CurveLog.js` (linha 19 do modelo actual).
- **`user_id`** — já obrigatório, capta o `actor_id` implicitamente
  (o user que chamou a rota). Para eventos admin, é o admin; para
  eventos de override, é o dono do override.
- **`error_detail`** — absorve toda a metadata estruturada (target
  ids, counts, snapshots minimos) em formato k=v space-separated.
  Truncado a 120 chars pelo helper existente.
- **`expense_id`** — já existe no schema. Preenchido no
  `expense_category_changed` (§34) com o `_id` da despesa. Para
  `apply_to_all` fica `null` — a operação é multi-doc, não aponta
  para uma única.
- **`entity`** — preenchido no `expense_category_changed` e no
  `override_*` com o valor raw do pattern / entidade. Dá ao
  `/curve/logs` uma forma de filtrar por entidade sem parsear o
  `error_detail`.

**Porquê não adicionar `target_id`, `target_type`, `before`, etc.
ao schema.** Três razões:

1. **3-file footgun já documentado.** `CURVE_LOGS.md §4.3` avisa
   que cada nova action exige 4 sítios actualizados. Adicionar
   também campos novos multiplica a superfície de mudança.
2. **Padrão pré-existente.** O `oauth_token_refreshed` já usa
   `error_detail` como saco estruturado
   (`"provider=microsoft accountId=… email=…"`). Seguir o padrão
   é mais barato que inventar um novo.
3. **Undo fica out-of-scope do MVP.** O "snapshot `before`"
   proposto em §6.8 era condição para o undo — que está
   explicitamente fora do escopo (§6.10). Sem undo, o snapshot
   é dead weight. Quando o undo for implementado em fase futura,
   a decisão de estender schema ou criar colecção dedicada
   (`curve_apply_to_all_history`) fica para essa PR.

### 13.4 O que NÃO é logado (deliberadamente)

Ruído a evitar, com razão explícita:

- **Leituras (GET).** `GET /api/categories`, `GET /api/category-
  overrides`, `GET /api/categories/stats` — alto volume, baixo
  valor informativo. Não deixam rasto.
- **Edições admin em curso no ecrã `/categories`.** O autosave de
  campo a campo (nome, ícone) não gera um log por keystroke —
  só o `PUT` final consolidado gera um `category_updated`.
- **Reordenações visuais.** Mudar a ordenação da lista do §9.3
  é estado local do cliente, não toca no backend, não há log.
- **Click no chip que fecha o popover sem guardar.** O §12.2
  trata dismiss como no-op — `PUT` só acontece em `Guardar`.
- **Apply-to-all em `dry_run: true`.** O preview do §8.5 não
  escreve ao DB nem loga — é só uma query com
  `$facet` ou equivalente, para o modal do §12.5 contar os
  afectados.
- **Eventos `expense_category_changed` consecutivos do mesmo user
  e entity no mesmo segundo.** Raros (dupla-click) mas dedup
  via `describeLog` no frontend (§13.5), não via supressão no
  backend.

### 13.5 Rendering no `/curve/logs` (delta do `CURVE_LOGS.md`)

O `client/src/pages/curveLogsUtils.js::describeLog(log)` ganha
os novos `case` correspondentes às acções da tabela §13.2. A
`CURVE_LOGS.md §4.3` já avisa deste acoplamento — os novos
labels aqui são a source of truth pt-PT (coluna "Canonical
pt-PT message"), copiada verbatim no switch.

**Batching.** O `groupSyncBatches` (`CURVE_LOGS.md §6.2`) agrupa
hoje linhas `sync` adjacentes do mesmo user com `entity != null`.
Proposta de extensão mínima:

- `expense_category_changed` beneficia do mesmo agrupamento —
  linhas adjacentes do mesmo user + `entity != null` do mesmo
  dia ficam clustered como *"N despesas recategorizadas
  manualmente"*.
- `category_entity_added` com várias entidades no mesmo POST já
  é uma única linha no backend (uma `audit()` call por POST,
  não uma por entidade). Não precisa de batching client-side.
- `apply_to_all` é sempre single row — o batching seria
  contra-produtivo, cada execução merece visibilidade.

**Filtros.** O `type=audit|sync` do §5 do `CURVE_LOGS.md` continua
a funcionar porque `action != null` marca todos estes como audit
rows. Proposta opcional: sub-filtro adicional
`?action_prefix=category_|override_|apply_to_all|expense_` para
o `/curve/logs` mostrar só eventos de categorização quando um
admin está a debugar. Extensão pequena, não bloqueante.

**Destaque visual.** As acções destrutivas (`category_deleted`,
`apply_to_all`, `apply_to_all_failed`, `admin_denied`) ganham
`bg-amber-50` ou `bg-red-50` consoante o `status`, consistente
com o padrão de `CURVE_LOGS.md §6.3`. As criações (`created`,
`added`) ficam com o neutral `bg-sand-100` — o acto em si é
benigno.

### 13.6 Retenção — consistente com `CURVE_LOGS.md §7`

O TTL de 90 dias do `CurveLog` (`created_at` index) aplica-se a
todos estes eventos sem excepção. Consequência importante: **o
rasto de auditoria para apply-to-all desaparece 90 dias depois**.
Para histórico permanente (compliance, forensic), seria preciso
um job de archival para outra colecção — fora do escopo do MVP
(§11.3 Fase 7).

Mitigação para o período do MVP: o `updated_at` das próprias
despesas re-catalogadas preserva a data da alteração para sempre
(não há TTL nos `expenses`), portanto mesmo passados 90 dias é
possível reconstruir quais despesas foram tocadas — só se perde
o actor e a regra que despoletou. Aceitável para já.

### 13.7 Checklist para implementação

Ao adicionar os 13 `action` values novos, cumprir o "3-file
footgun" de `CURVE_LOGS.md §4.3` **para cada um**:

1. **`server/src/models/CurveLog.js`** — adicionar ao enum.
2. **`server/src/services/audit.js`** — verificar a heurística
   de status: `apply_to_all_failed` e `admin_denied` são
   automáticos (contêm `failed` / são `*_denied`? ver §4.2 do
   `CURVE_LOGS.md`). `admin_denied` **não** contém `failed` no
   nome — adicionar branch explícito no helper, ou renomear
   para `admin_access_failed`. Recomendação: renomear para
   cumprir a convenção existente.
3. **`client/src/pages/curveLogsUtils.js`** — adicionar os 13
   `case` com os textos canónicos da tabela §13.2.
4. **`docs/CURVE_LOGS.md §4`** — acrescentar as 13 linhas à
   tabela de referência (ou linkar para esta §13.2 como source
   of truth e evitar duplicação). Preferência: **link**, para
   manter uma única fonte de verdade.

**Correcção à tabela §13.2.** O item #35 `admin_denied` deve
ser renomeado para `admin_access_failed` antes da implementação,
para cumprir o mandato do `CURVE_LOGS.md §4.2` (heurística
`includes('failed')`). O `action` canonical fica
`admin_access_failed`; a mensagem pt-PT permanece `"Acesso
admin recusado: <method> <path>"`.

### 13.8 Resposta às perguntas do user

- **"Há log quando altero a categoria em todas as despesas de uma
  entidade?"** — Sim, item #32 `apply_to_all` da tabela §13.2.
  Carrega `scope`, `target`, `affected`, `skipped_personal`, e
  a canonical message mostra `"Aplicado a N despesas: <pattern>
  → <category>"`. Falha catastrófica gera #33
  `apply_to_all_failed`.
- **"Há log quando uma entidade é associada a uma categoria?"** —
  Depende de qual camada:
  - **Admin adiciona ao catálogo global** → #26
    `category_entity_added` (batch-capable, até N entidades por
    POST).
  - **User cria override pessoal** → #29 `override_created` com o
    pattern no `error_detail`.
  - **User faz quick-edit single-expense** → #34
    `expense_category_changed`, com `entity`, `from`, `to` e
    `expense_id`.
- **"Que logs consideras importantes?"** — Todos os 13 da
  tabela §13.2 têm justificação no §13.1 (debug, segurança,
  undo futuro). A §13.4 lista o que deliberadamente fica de
  fora para não poluir o `/curve/logs`.
