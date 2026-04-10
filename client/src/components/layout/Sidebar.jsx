import { NavLink } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import {
  HomeIcon,
  BanknotesIcon,
  CogIcon,
  ClipboardDocumentListIcon,
  ArrowRightOnRectangleIcon,
} from './Icons';

const links = [
  { to: '/', label: 'Dashboard', icon: HomeIcon },
  { to: '/expenses', label: 'Despesas', icon: BanknotesIcon },
  { to: '/curve/config', label: 'Configuração', icon: CogIcon },
  { to: '/curve/logs', label: 'Logs', icon: ClipboardDocumentListIcon },
];

export default function Sidebar() {
  const { user, logout } = useAuth();

  return (
    <aside className="flex w-64 flex-col border-r border-sand-200 bg-white">
      {/* Brand */}
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-curve-700">
          <span className="text-sm font-bold text-white">CS</span>
        </div>
        <span className="text-lg font-semibold text-sand-900">
          Curve Sync
        </span>
      </div>

      {/* Navigation */}
      <nav className="mt-4 flex flex-1 flex-col gap-1 px-3">
        {links.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
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
