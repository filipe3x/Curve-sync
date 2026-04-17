import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  HomeIcon,
  BanknotesIcon,
  FolderIcon,
  CogIcon,
  ClipboardDocumentListIcon,
  ArrowRightOnRectangleIcon,
  XMarkIcon,
} from './Icons';

const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/expenses', label: 'Despesas', icon: BanknotesIcon },
  { to: '/categories', label: 'Categorias', icon: FolderIcon },
  { to: '/curve/config', label: 'Configuração', icon: CogIcon },
  { to: '/curve/logs', label: 'Logs', icon: ClipboardDocumentListIcon },
];

/**
 * Sidebar body. Rendered in two contexts:
 *  - desktop (≥ lg): statically docked to the left by `Shell`
 *  - mobile (< lg): inside a slide-in drawer whose open/close state
 *    lives in `Shell`. `onNavigate` is called after every NavLink
 *    click so `Shell` can close the drawer on navigation (otherwise
 *    the user has to tap twice: once for the link, once for the
 *    backdrop).
 *  - `onClose` renders a close button inside the drawer header so
 *    touch targets are reachable with thumbs at the top of the panel.
 *    Desktop passes `null` and the button hides.
 */
export default function Sidebar({ onNavigate, onClose = null }) {
  const { user, logout } = useAuth();

  return (
    <aside className="flex h-full w-64 flex-col border-r border-sand-200 bg-white">
      {/* Brand */}
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-curve-700">
          <span className="text-sm font-bold text-white">CS</span>
        </div>
        <span className="text-lg font-semibold text-sand-900">
          Curve Sync
        </span>
        {/* Close (mobile drawer only). Rendered last inside the brand
            row so it aligns with the hamburger button that opened the
            drawer in the topbar. */}
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar menu"
            className="ml-auto rounded-lg p-1.5 text-sand-500 transition-colors hover:bg-sand-100 hover:text-sand-800 lg:hidden"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        )}
      </div>

      {/* Navigation */}
      <nav className="mt-4 flex flex-1 flex-col gap-1 px-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors duration-200 ${
                isActive
                  ? 'bg-curve-50 text-curve-800'
                  : 'text-sand-600 hover:bg-sand-100 hover:text-sand-900'
              }`
            }
          >
            <Icon className="h-5 w-5" />
            {label}
          </NavLink>
        ))}
      </nav>

      {/* User + Logout */}
      <div className="border-t border-sand-200 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="truncate text-sm font-medium text-sand-800">
              {user?.email}
            </p>
            <p className="text-xs text-sand-400">{user?.role}</p>
          </div>
          <button
            onClick={logout}
            title="Terminar sessão"
            className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 hover:text-sand-700"
          >
            <ArrowRightOnRectangleIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
