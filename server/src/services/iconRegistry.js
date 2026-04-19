/**
 * Server-side whitelist of icon names that `CategoryIcon.icon_name` is
 * allowed to carry. The canonical source of truth is the client-side
 * `ICON_REGISTRY` in `client/src/components/common/CategoryIcon.jsx`
 * — both lists MUST stay aligned. Duplication is intentional: the
 * client needs to map `icon_name → React component` to render, the
 * server only needs to reject writes outside the set; sharing a
 * single source via a bundler import is cost that doesn't pay off
 * at ~36 strings.
 *
 * Values are the PascalCase component names exported by
 * `lucide-react@1.8.0`. A write carrying anything outside this set
 * gets a 400 `invalid_icon_name`; that guard is the whole reason
 * the whitelist exists, since MongoDB happily accepts any string.
 *
 * How to extend: add the icon here AND to `ICON_REGISTRY` in the
 * client file, deploy both, done. No migrations — existing docs
 * keep their current `icon_name` strings unchanged.
 */
export const ALLOWED_ICON_NAMES = new Set([
  // Compras e casa
  'ShoppingCart',
  'ShoppingBag',
  'Home',
  'Utensils',
  'Coffee',
  // Transporte
  'Car',
  'Fuel',
  'Plane',
  'Ticket',
  // Saúde e bem-estar
  'Stethoscope',
  'Pill',
  'Heart',
  'Dumbbell',
  // Lazer
  'Film',
  'Music',
  'Book',
  'Gamepad',
  'Camera',
  // Serviços
  'Smartphone',
  'Wifi',
  'Zap',
  'Flame',
  'Droplet',
  'Wrench',
  // Dinheiro
  'CreditCard',
  'Wallet',
  'Receipt',
  'PiggyBank',
  'Banknote',
  // Outros
  'Shirt',
  'Scissors',
  'Briefcase',
  'Gift',
  'Baby',
  'Dog',
  'Paintbrush',
  'Tag', // fallback / "sem ícone específico"
]);

export function isAllowedIconName(name) {
  return typeof name === 'string' && ALLOWED_ICON_NAMES.has(name);
}
