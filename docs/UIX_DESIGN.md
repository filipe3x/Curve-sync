# UIX Design — Curve Sync

> Documento resumo do sistema de design. Ver `UIX_DESIGN_V2.md` para especificação completa.

---

## 1. Identidade Visual

**Filosofia:** Fintech minimalista, monocromática, warm. Inspirada no Curve.com (clean, whitespace, premium) mas com paleta terracotta/sand em vez do preto/azul original.

**Princípios:**
- Simplicidade sobre complexidade — cada ecrã faz uma coisa bem
- Monocromático warm — cor usada com parcimónia (apenas para acentos e acções)
- Micro-animações subtis — fade-ins e slides que dão vida sem distrair
- Tipografia como hierarquia — tamanhos, pesos e opacidade em vez de decoração

---

## 2. Paleta de Cores

### Curve (vermelho-castanho terracotta) — cor de acção
| Token | Hex | Uso |
|-------|-----|-----|
| `curve-50` | `#fdf6f3` | Background de item activo na sidebar |
| `curve-300` | `#edab96` | Spinner border secundário |
| `curve-500` | `#d4633f` | Focus ring dos inputs |
| `curve-600` | `#c04e30` | Texto de erro inline |
| `curve-700` | `#a03d27` | **Cor primária** — botões, montantes, brand mark |
| `curve-800` | `#843525` | Hover de botão primário, texto activo sidebar |

### Sand (cinzento quente) — cor estrutural
| Token | Hex | Uso |
|-------|-----|-----|
| `sand-50` | `#faf9f7` | **Background global** (`body`) |
| `sand-100` | `#f3f1ec` | Hover de linhas, badges de categoria |
| `sand-200` | `#e6e1d8` | Borders (cards, sidebar, tabelas) |
| `sand-300` | `#d4ccbd` | Borders de inputs e botões secundários |
| `sand-400` | `#bfb39e` | Texto terciário (labels, placeholders, contadores) |
| `sand-500` | `#b0a089` | Texto secundário (descrições, datas) |
| `sand-600` | `#a08e77` | Texto de navegação inactiva |
| `sand-800` | `#6d6054` | Texto de botão secundário |
| `sand-900` | `#5a5046` | **Texto principal** (títulos, nomes de entidade) |
| `sand-950` | `#2f2a24` | `body` text color base |

### Semânticas (pontuais)
- **Sucesso:** `emerald-50` bg + `emerald-700` text
- **Aviso:** `amber-50` bg + `amber-700` text
- **Erro:** `red-50` bg + `curve-700` text (usa a cor primária, não vermelho puro)

---

## 3. Tipografia

**Fonte:** Inter (fallback: system-ui, -apple-system, Segoe UI, Roboto, sans-serif)

| Elemento | Classe | Tamanho | Peso |
|----------|--------|---------|------|
| Título de página | `text-2xl font-semibold` | 1.5rem | 600 |
| Título de secção | `text-lg font-semibold` | 1.125rem | 600 |
| Valor de stat card | `text-2xl font-semibold` | 1.5rem | 600 |
| Label de stat card | `text-xs font-medium uppercase tracking-wide` | 0.75rem | 500 |
| Corpo de tabela | `text-sm` | 0.875rem | 400 |
| Header de tabela | `text-xs font-medium uppercase tracking-wide` | 0.75rem | 500 |
| Montante (EUR) | `text-sm font-semibold text-curve-700` | 0.875rem | 600 |
| Label de form | `text-xs font-medium` | 0.75rem | 500 |
| Descrição | `text-sm text-sand-500` | 0.875rem | 400 |
| Versão/footer | `text-xs text-sand-400` | 0.75rem | 400 |

---

## 4. Animações

Três keyframes, todos `ease-out`, sem loop:

| Nome | Duração | Movimento | Onde é usado |
|------|---------|-----------|--------------|
| `fade-in` | 0.4s | translateY(8px) → 0 + opacity | Shell content wrapper, tabelas, empty states |
| `fade-in-up` | 0.5s | translateY(16px) → 0 + opacity | Stat cards, form cards |
| `slide-in-right` | 0.4s | translateX(16px) → 0 + opacity | Disponível (reservado para toasts/notificações) |

**Stagger em tabelas:** Linhas de despesas recentes usam `animationDelay: i * 60ms` para efeito cascata.

**Spinner de loading:** `animate-spin` num `div` circular com `border-2 border-curve-300 border-t-curve-700` (6x6).

**Micro-interacções:** Botões têm `active:scale-[0.98]` para feedback tátil. Linhas de tabela e cards têm `transition-colors duration-150` / `transition-shadow duration-300`.

---

## 5. Componentes Core

### 5.1 Shell + Sidebar
```
Layout: flex min-h-screen
Sidebar: w-64, bg-white, border-r border-sand-200
Main: flex-1, px-6 py-8 lg:px-10, max-w-6xl centered
```
- **Brand:** Quadrado `h-9 w-9 rounded-xl bg-curve-700` com iniciais "CS" em branco
- **Nav links:** `rounded-xl px-3 py-2.5`, activo = `bg-curve-50 text-curve-800`, inactivo = `text-sand-600 hover:bg-sand-100`
- **Footer:** `text-xs text-sand-400` com versão

### 5.2 Card
```css
bg-white rounded-2xl border border-sand-200 p-6 shadow-sm
hover:shadow-md transition-shadow duration-300
```

### 5.3 Botões
```
Primary:   rounded-xl bg-curve-700 px-5 py-2.5 text-sm font-medium text-white
           hover:bg-curve-800 active:scale-[0.98]

Secondary: rounded-xl border border-sand-300 bg-white px-5 py-2.5
           text-sm font-medium text-sand-800
           hover:bg-sand-100 active:scale-[0.98]
```

### 5.4 Input
```
rounded-xl border border-sand-300 bg-white px-4 py-2.5 text-sm
placeholder-sand-400
focus:border-curve-500 focus:ring-2 focus:ring-curve-500/20
```

### 5.5 Badges
```
Base:    rounded-lg px-2.5 py-1 text-xs font-medium
OK:      bg-emerald-50 text-emerald-700
Error:   bg-red-50 text-curve-700
Pending: bg-amber-50 text-amber-700
Neutral: bg-sand-100 text-sand-600  (categorias)
```

### 5.6 Tabela de Dados
```
Container: rounded-2xl border border-sand-200 bg-white overflow-hidden
Header:    border-b border-sand-100, text uppercase tracking-wide sand-400
Linhas:    border-b border-sand-50, hover:bg-sand-50, transition 150ms
Cells:     px-5 py-3
```

### 5.7 Paginação
```
Barra inferior da tabela: border-t border-sand-100 px-5 py-3
Contador: text-xs text-sand-400 (esquerda)
Setas: rounded-lg p-1.5 text-sand-400 hover:bg-sand-100 disabled:opacity-30
Página: text-xs text-sand-500 "1 / 5"
```

### 5.8 Empty State
```
rounded-2xl border-2 border-dashed border-sand-200 py-16 text-center
Ícone: h-12 w-12 rounded-full bg-sand-100 com "∅" text-xl text-sand-400
Título: text-sm font-medium text-sand-700
Descrição: text-xs text-sand-400
```

### 5.9 Mensagens Inline (Config)
```
rounded-xl px-4 py-3 text-sm transition-opacity duration-300
Sucesso: bg-emerald-50 text-emerald-700
Erro:    bg-red-50 text-curve-700
```

---

## 6. Ecrãs

| Rota | Página | Composição |
|------|--------|------------|
| `/` | Dashboard | PageHeader + btn sync, 4x StatCard grid (2/4 cols), tabela despesas recentes |
| `/expenses` | Despesas | PageHeader, search bar com ícone, tabela paginada (20/página) |
| `/curve/config` | Configuracao | PageHeader, card-form com 6 campos + toggle, botões guardar/testar |
| `/curve/logs` | Logs | PageHeader, tabela paginada (30/página) com badges de status + digest truncado |

---

## 7. Iconografia

8 ícones SVG inline (sem dependência externa), `stroke="currentColor"` com `strokeWidth={1.5}` (excepto PlusIcon: `strokeWidth={2}`):

`HomeIcon` `BanknotesIcon` `CogIcon` `ClipboardDocumentListIcon` `ArrowPathIcon` `ChevronLeftIcon` `ChevronRightIcon` `MagnifyingGlassIcon` `PlusIcon`

---

## 8. Border Radius

| Token | Valor | Uso |
|-------|-------|-----|
| `rounded-lg` | 0.5rem | Badges, botões de paginação, code blocks |
| `rounded-xl` | 0.75rem | Botões, inputs, nav links, brand mark |
| `rounded-2xl` | 1rem | Cards, tabelas, empty states, mensagens |
| `rounded-full` | 50% | Spinner, ícone do empty state |

---

## 9. Spacing Pattern

- **Page padding:** `px-6 py-8` (mobile), `lg:px-10` (desktop)
- **Max content width:** `max-w-6xl` (~72rem)
- **Card padding:** `p-6`
- **Table cell padding:** `px-5 py-3`
- **Form gap:** `gap-5` entre campos
- **Grid gap:** `gap-4` entre stat cards
- **Section gap:** `mt-8` entre secções da página
- **Header margin-bottom:** `mb-8`

---

## 10. Loading States

**Spinner central:** Usado nas páginas Despesas e Logs enquanto os dados carregam.
```
Container: flex items-center justify-center py-20
Spinner:   h-6 w-6 animate-spin rounded-full
           border-2 border-curve-300 border-t-curve-700
```
A técnica `border-t` cria o arco visível que roda sobre o anel `curve-300` mais claro.

**Botões com estado de loading:** Os botões primário e secundário suportam `disabled` nativo. O texto muda para indicar a acção em curso, mantendo o ícone (ex: `ArrowPathIcon` ganha `animate-spin`):

| Botão | Estado normal | Estado loading |
|-------|-------------|----------------|
| Sync (Dashboard) | "Sincronizar agora" | "A sincronizar..." + ícone spin |
| Guardar (Config) | "Guardar" | "A guardar..." |
| Testar (Config) | "Testar ligação" | "A testar..." |

Padrão: o state `syncing`/`saving`/`testing` controla o `disabled` e o texto. Não há overlay — o botão simplesmente fica inerte e o label muda.

---

## 11. Localização

Toda a interface está em **Português Europeu** (pt-PT).

- **Labels de navegação:** Dashboard, Despesas, Configuração, Logs
- **Headers de tabela:** Entidade, Montante, Data, Cartão, Categoria, Estado, Digest
- **Placeholders:** "Pesquisar por entidade, cartão...", "imap.outlook.com", "email@example.com"
- **Mensagens de feedback:** "Configuração guardada.", "Ligação bem-sucedida.", "Não foi possível carregar dados."
- **Empty states:** "Sem despesas", "Sem resultados", "Sem logs"
- **Formatação:** Datas com `toLocaleString('pt-PT')`, montantes com prefixo `€` (ex: `€12.50`)
- **Pluralização:** `despesa/despesas`, `log/logs` (condicional com `total !== 1`)

> **Nota:** O `<html lang="pt">` deve estar definido no `index.html` raiz. Textos do sistema (console, API errors) permanecem em inglês — apenas a camada de apresentação é localizada.

---

## 12. Responsividade

### Breakpoints activos

| Breakpoint | Tailwind | Onde é usado |
|------------|----------|--------------|
| Default (mobile-first) | — | Layout base: sidebar fixa, `px-6 py-8` |
| `sm` (640px) | `sm:grid-cols-2` | Stat cards: 2 colunas em tablet |
| `lg` (1024px) | `lg:grid-cols-4`, `lg:px-10` | Stat cards: 4 colunas em desktop, padding lateral maior |

### Limitações actuais
- A sidebar é fixa `w-64` sem comportamento de drawer/collapse em mobile
- Tabelas não têm scroll horizontal ou layout alternativo em ecrãs pequenos
- O formulário de config usa `max-w-xl` que se adapta naturalmente

### Roadmap (Fase 3.1)
Sidebar responsiva com drawer mobile e hamburger menu está prevista. O layout `flex min-h-screen` actual suporta a adição de toggle sem refactoring estrutural.

---

## 13. Focus & Acessibilidade

### Focus States
Os inputs têm um focus state explícito e visível:
```
focus:border-curve-500 focus:outline-none focus:ring-2 focus:ring-curve-500/20
```
O `outline-none` remove o default do browser e substitui por um `ring` com 20% de opacidade da cor primária — subtil mas claramente visível sobre o fundo sand.

### Disabled States
- **Botões:** O atributo `disabled` nativo é usado; Tailwind não aplica estilos custom de disabled nos botões (dependem do browser default de redução de opacidade)
- **Paginação:** Setas com `disabled:opacity-30` para indicar limites de navegação
- **Checkbox:** Usa classes nativas do browser com `text-curve-700 focus:ring-curve-500`

### Hierarquia de Headings
Cada página segue uma estrutura semântica consistente:
- `<h1>` — Título da página (via `PageHeader`, `text-2xl`)
- `<h2>` — Títulos de secção (ex: "Despesas recentes" no Dashboard, `text-lg`)
- Sem `<h3>`+ actualmente — a hierarquia é plana por design (ecrãs simples)

### Navegação
- Links da sidebar usam `<NavLink>` do React Router com `end` prop para matching exacto
- Ícones SVG são decorativos (sem `aria-label`) — o texto do link fornece o contexto

---

## 14. Dark Mode

**Estado actual:** Não implementado. A UI usa valores de cor fixos (`bg-white`, `bg-sand-50`, `text-sand-950`).

**Roadmap (Fase 3.3):** Previsto como feature futura. A paleta monocromática warm adapta-se naturalmente a uma inversão dark:

| Light | Dark (proposta) |
|-------|----------------|
| `sand-50` (bg) | `sand-950` |
| `white` (cards) | `sand-900` |
| `sand-950` (texto) | `sand-50` |
| `sand-200` (borders) | `sand-800` |
| `curve-700` (primária) | `curve-500` (mais claro para contraste) |

A estrutura Tailwind já está preparada — basta adicionar `darkMode: 'class'` ao config e classes `dark:` aos componentes.

---

## 15. Search Pattern

Usado na página de Despesas — input com ícone posicionado à esquerda:

```
Container: relative flex-1
Ícone:     absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-sand-400
Input:     .input pl-10  (padding-left extra para não sobrepor o ícone)
```

O `MagnifyingGlassIcon` fica fixo visualmente dentro do campo. O `pl-10` (2.5rem) no input compensa o espaço do ícone (left-3 = 0.75rem + w-4 = 1rem + margem). O form usa `onSubmit` — o botão "Pesquisar" (`btn-secondary`) submete a pesquisa; não há pesquisa em tempo real (debounce) actualmente.

---

## 16. Futuro: Sistema de Toasts (Roadmap 3.2)

A animação `slide-in-right` (0.4s, translateX 16px → 0) está **reservada** para o sistema de notificações toast.

**Comportamento previsto:**
- Toasts aparecem no canto superior-direito com `slide-in-right`
- Auto-dismiss após ~4s com fade-out
- Tipos: sucesso (emerald), erro (curve-700), info (sand)
- Substituirá os `/* toast later */` comments no código actual (ex: `DashboardPage` sync error)
- As mensagens inline do `CurveConfigPage` poderão coexistir ou migrar para toasts

**Nota:** Actualmente os erros de sync são silenciados (`catch { /* toast later */ }`) — o toast system é a peça que falta para feedback completo ao utilizador.
