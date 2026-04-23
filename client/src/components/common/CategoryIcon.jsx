/**
 * CategoryIcon — render a Lucide glyph by its PascalCase name, with
 * a deterministic fallback when the name is missing or unknown.
 *
 * Background: Curve Sync deliberately does not reuse Embers'
 * Paperclip-based icon attachment (the `icon_*` fields on the
 * shared `categories` docs live on Embers' filesystem and we have
 * no access path to the bytes). Instead, a Curve-Sync-owned
 * collection `curve_category_icons` maps `category_id → icon_name`,
 * where `icon_name` is a string matching one of the keys in
 * `ICON_REGISTRY` below. The server validates writes against the
 * mirror whitelist in `server/src/services/iconRegistry.js`, so
 * anything that lands in the DB is guaranteed renderable here.
 *
 * Source of truth: the ordered list `ICON_CATALOGUE` below is what
 * the picker UI iterates to draw tiles. `ICON_REGISTRY` is the
 * same set keyed by name for O(1) lookup by consumers rendering an
 * already-stored icon. Both derive from the same per-group
 * declarations, so adding an icon is a one-line edit to one of the
 * THEME groups — no duplication, no drift.
 *
 * Keeping the list aligned with the server whitelist is manual:
 * ANY edit to the names here MUST also update
 * `server/src/services/iconRegistry.js :: ALLOWED_ICON_NAMES`.
 * The duplication is intentional — a shared bundler-crossing
 * module would be more ceremony than this saves at ~37 strings.
 */
import {
  ShoppingCart,
  ShoppingBag,
  Home,
  Utensils,
  Coffee,
  Car,
  Fuel,
  Plane,
  Ticket,
  Stethoscope,
  Pill,
  Heart,
  Dumbbell,
  Film,
  Music,
  Book,
  Gamepad,
  Camera,
  Smartphone,
  Wifi,
  Zap,
  Flame,
  Droplet,
  Wrench,
  CreditCard,
  Wallet,
  Receipt,
  PiggyBank,
  Banknote,
  Shirt,
  Scissors,
  Briefcase,
  Gift,
  Baby,
  Dog,
  Paintbrush,
  Tag,
} from 'lucide-react';

// Themed groups feeding both the registry and the ordered catalogue.
// Order within each group matters for the picker UI — most-common
// icons first so the picker's first visual row carries the heavy
// hitters (groceries, home, restaurants, coffee).
//
// `label` is what the picker tile shows below the glyph. Pt-PT is
// the user-facing language, matching the rest of the admin surface.
const GROUPS = [
  {
    label: 'Compras e casa',
    icons: [
      { name: 'ShoppingCart', component: ShoppingCart, label: 'Compras' },
      { name: 'ShoppingBag', component: ShoppingBag, label: 'Saco' },
      { name: 'Home', component: Home, label: 'Casa' },
      { name: 'Utensils', component: Utensils, label: 'Restaurantes' },
      { name: 'Coffee', component: Coffee, label: 'Cafés' },
    ],
  },
  {
    label: 'Transporte',
    icons: [
      { name: 'Car', component: Car, label: 'Carro' },
      { name: 'Fuel', component: Fuel, label: 'Combustível' },
      { name: 'Plane', component: Plane, label: 'Viagens' },
      { name: 'Ticket', component: Ticket, label: 'Bilhetes' },
    ],
  },
  {
    label: 'Saúde e bem-estar',
    icons: [
      { name: 'Stethoscope', component: Stethoscope, label: 'Saúde' },
      { name: 'Pill', component: Pill, label: 'Farmácia' },
      { name: 'Heart', component: Heart, label: 'Coração' },
      { name: 'Dumbbell', component: Dumbbell, label: 'Ginásio' },
    ],
  },
  {
    label: 'Lazer',
    icons: [
      { name: 'Film', component: Film, label: 'Cinema' },
      { name: 'Music', component: Music, label: 'Música' },
      { name: 'Book', component: Book, label: 'Livros' },
      { name: 'Gamepad', component: Gamepad, label: 'Jogos' },
      { name: 'Camera', component: Camera, label: 'Fotografia' },
    ],
  },
  {
    label: 'Serviços',
    icons: [
      { name: 'Smartphone', component: Smartphone, label: 'Telemóvel' },
      { name: 'Wifi', component: Wifi, label: 'Internet' },
      { name: 'Zap', component: Zap, label: 'Electricidade' },
      { name: 'Flame', component: Flame, label: 'Gás' },
      { name: 'Droplet', component: Droplet, label: 'Água' },
      { name: 'Wrench', component: Wrench, label: 'Reparações' },
    ],
  },
  {
    label: 'Dinheiro',
    icons: [
      { name: 'CreditCard', component: CreditCard, label: 'Cartão' },
      { name: 'Wallet', component: Wallet, label: 'Carteira' },
      { name: 'Receipt', component: Receipt, label: 'Facturas' },
      { name: 'PiggyBank', component: PiggyBank, label: 'Poupança' },
      { name: 'Banknote', component: Banknote, label: 'Notas' },
    ],
  },
  {
    label: 'Outros',
    icons: [
      { name: 'Shirt', component: Shirt, label: 'Roupa' },
      { name: 'Scissors', component: Scissors, label: 'Cabeleireiro' },
      { name: 'Briefcase', component: Briefcase, label: 'Trabalho' },
      { name: 'Gift', component: Gift, label: 'Ofertas' },
      { name: 'Baby', component: Baby, label: 'Bebé' },
      { name: 'Dog', component: Dog, label: 'Animais' },
      { name: 'Paintbrush', component: Paintbrush, label: 'Pintura' },
      { name: 'Tag', component: Tag, label: 'Genérico' },
    ],
  },
];

// Flat ordered list for the picker. `id: label` acts as a stable key
// for React list rendering and identifies group separators.
export const ICON_CATALOGUE = GROUPS;

// Map `name → { component, label }` for the hot lookup path used by
// CategoryIcon render calls. Built once at module load, never
// mutated.
export const ICON_REGISTRY = Object.freeze(
  Object.fromEntries(
    GROUPS.flatMap((g) => g.icons).map((i) => [
      i.name,
      { component: i.component, label: i.label },
    ]),
  ),
);

// Default glyph shown when:
//   - A category has no icon configured (no `curve_category_icons`
//     row for its `category_id`).
//   - The stored `icon_name` is not in the current registry (the
//     whitelist shrank after an old row was written — defensive,
//     since the server validates writes, but keeps the renderer
//     safe during whitelist edits).
//   - The caller passes an explicitly empty/null name.
//
// `Tag` was picked because it's the quintessential "label" glyph
// and reads as neutral in both the small (16px) and large (24px)
// render sizes used across the app.
export const DEFAULT_ICON_NAME = 'Tag';

/**
 * Render the Lucide glyph for `name`, falling back to `Tag` when
 * the name is missing or unknown. Passes every other prop through
 * to the underlying Lucide component, so callers can set
 * `className`, `size`, `strokeWidth`, ARIA props, etc. without the
 * component needing explicit support.
 *
 * @param {Object} props
 * @param {string|null|undefined} props.name  Icon name from the
 *   registry (or null/undefined for fallback).
 */
export function CategoryIcon({ name, ...rest }) {
  const entry = (name && ICON_REGISTRY[name]) || ICON_REGISTRY[DEFAULT_ICON_NAME];
  const Icon = entry.component;
  return <Icon {...rest} />;
}
