# Categories — Design & Implementation

> **Estado:** esqueleto. Cada capítulo abaixo é um placeholder com um resumo
> do que vai ser coberto. Vamos expandir capítulo a capítulo.

---

## 1. Contexto e objectivos

_Placeholder._ Porquê este documento existe: a catalogação automática
actualmente deixa a desejar (match ingénuo, sem overrides, sem UI em
Curve Sync) e o utilizador pediu um sistema mais eficaz com dois níveis
de privilégio. Lista os objectivos concretos: catalogação mais precisa,
CRUD de categorias em Curve Sync, overrides per-user, re-catalogação
retroactiva, ecrã único com totais + catálogo de entidades.

## 2. Estado actual e limitações

_Placeholder._ Inventário do que existe hoje em Embers e em Curve Sync:

- Embers: `Category.entities[]` + `before_create :assign_category` com
  match exacto por `$in` e fallback para "General".
- Curve Sync: `assignCategoryFromList()` com `includes()`
  case-insensitive; `/api/categories` read-only; sem UI de gestão.

Lista as fraquezas identificadas no estudo (sem normalização, sem
overrides, sem aprendizagem, sem UI, risco de falsos positivos por
substrings curtas, etc.) para justificar as mudanças das secções
seguintes.

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
