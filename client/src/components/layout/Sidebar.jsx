import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  HomeIcon,
  BanknotesIcon,
  FolderIcon,
  CogIcon,
  ClipboardDocumentListIcon,
  ArrowRightOnRectangleIcon,
} from './Icons';

const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/expenses', label: 'Despesas', icon: BanknotesIcon },
  { to: '/categories', label: 'Categorias', icon: FolderIcon },
  { to: '/curve/config', label: 'Configuração', icon: CogIcon },
  { to: '/curve/logs', label: 'Logs', icon: ClipboardDocumentListIcon },
];

/**
 * Navigation rail / sidebar.
 *
 * Single responsive component — collapses to an icon-only rail below
 * `lg` (1024px) and expands to a full text+icon sidebar above. This
 * replaced the slide-in drawer pattern because on narrow portrait
 * phones the drawer either (a) doubled the brand badge against the
 * wordmark in the topbar, or (b) forced an extra tap every time the
 * user wanted to switch section. An always-visible rail keeps every
 * destination one tap away at the cost of ~64 px of horizontal real
 * estate, which mobile layouts already reserve for OS chrome anyway.
 *
 * Accessibility: each NavLink carries the human label in `aria-label`
 * + `title` even though the text is hidden on mobile, so screen
 * readers and tooltips read the same thing as the expanded sidebar.
 */
export default function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside
      className="flex w-16 flex-col border-r border-sand-200 bg-white lg:w-64"
      aria-label="Navegação"
    >
      {/* Brand — "CS" badge only on mobile, badge + wordmark on desktop. */}
      <div className="flex h-16 items-center justify-center gap-3 lg:justify-start lg:px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-curve-700">
          <span className="text-sm font-bold text-white">CS</span>
        </div>
        <span className="hidden text-lg font-semibold text-sand-900 lg:inline">
          Curve Sync
        </span>
      </div>

      {/* Vertical nav — icons only below lg, icon + label above. */}
      <nav className="mt-4 flex flex-1 flex-col gap-1 px-2 lg:px-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            title={label}
            aria-label={label}
            className={({ isActive }) =>
              `flex items-center justify-center gap-3 rounded-xl p-2.5 text-sm font-medium transition-colors duration-200 lg:justify-start lg:px-3 ${
                isActive
                  ? 'bg-curve-50 text-curve-800'
                  : 'text-sand-600 hover:bg-sand-100 hover:text-sand-900'
              }`
            }
          >
            <Icon className="h-5 w-5 shrink-0" />
            <span className="hidden lg:inline">{label}</span>
          </NavLink>
        ))}
      </nav>

      {/* User + logout. Email hidden on mobile rail (no horizontal room) —
          tap the logout icon to end the session. */}
      <div className="border-t border-sand-200 px-2 py-3 lg:px-4 lg:py-4">
        <div className="flex flex-col items-center gap-2 lg:flex-row lg:gap-3">
          <div className="hidden min-w-0 flex-1 lg:block">
            <p className="truncate text-sm font-medium text-sand-800">
              {user?.email}
            </p>
            <p className="text-xs text-sand-400">{user?.role}</p>
          </div>
          <button
            onClick={logout}
            title={user?.email ? `Terminar sessão (${user.email})` : 'Terminar sessão'}
            aria-label="Terminar sessão"
            className="rounded-lg p-1.5 text-sand-400 transition-colors hover:bg-sand-100 hover:text-sand-700"
          >
            <ArrowRightOnRectangleIcon className="h-5 w-5" />
          </button>
        </div>
      </div>
    </aside>
  );
}
