import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { login as apiLogin } from '../services/api';

export default function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const { token, user } = await apiLogin({ email, password });
      login(token, user);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-sand-50 px-4">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 flex items-center justify-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-curve-700">
            <span className="text-base font-bold text-white">CS</span>
          </div>
          <span className="text-2xl font-semibold text-sand-900">Curve Sync</span>
        </div>

        <form onSubmit={handleSubmit} className="card">
          <h2 className="mb-6 text-center text-lg font-semibold text-sand-900">
            Iniciar sessão
          </h2>

          {error && (
            <div className="mb-4 rounded-xl bg-red-50 px-4 py-3 text-sm text-curve-700">
              {error}
            </div>
          )}

          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium text-sand-700">Email</span>
            <input
              type="email"
              className="input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="email"
            />
          </label>

          <label className="mb-6 block">
            <span className="mb-1 block text-sm font-medium text-sand-700">Password</span>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
            />
          </label>

          <button type="submit" className="btn-primary w-full" disabled={loading}>
            {loading ? 'A entrar...' : 'Entrar'}
          </button>

          <p className="mt-4 text-center text-xs text-sand-500">
            Não tens conta?{' '}
            <Link to="/register" className="text-curve-700 hover:underline">
              Registar
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
