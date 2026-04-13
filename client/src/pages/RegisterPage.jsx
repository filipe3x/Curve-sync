import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { register as apiRegister } from '../services/api';

const MIN_PASSWORD_LENGTH = 8;

export default function RegisterPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordConfirmation, setPasswordConfirmation] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

    // Client-side guards mirror the server validators in
    // server/src/routes/auth.js. The server is the source of truth —
    // these only exist so the user gets immediate feedback without a
    // round-trip.
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`A password tem de ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`);
      return;
    }
    if (password !== passwordConfirmation) {
      setError('A confirmação da password não coincide.');
      return;
    }

    setLoading(true);
    try {
      const { token, user } = await apiRegister({
        email,
        password,
        password_confirmation: passwordConfirmation,
      });
      // Auto-login: server already opened a session and returned the
      // token. AuthContext.login() pins it to localStorage and the
      // protected-route gate flips on the next render.
      login(token, user);
      // New users land on the OAuth wizard — the next thing they need
      // is an inbox to read receipts from.
      navigate('/curve/setup', { replace: true });
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
            Criar conta
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

          <label className="mb-4 block">
            <span className="mb-1 block text-sm font-medium text-sand-700">Password</span>
            <input
              type="password"
              className="input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
            />
            <span className="mt-1 block text-xs text-sand-500">
              Mínimo {MIN_PASSWORD_LENGTH} caracteres.
            </span>
          </label>

          <label className="mb-6 block">
            <span className="mb-1 block text-sm font-medium text-sand-700">
              Confirmar password
            </span>
            <input
              type="password"
              className="input"
              value={passwordConfirmation}
              onChange={(e) => setPasswordConfirmation(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              autoComplete="new-password"
            />
          </label>

          <button type="submit" className="btn-primary w-full" disabled={loading}>
            {loading ? 'A criar conta...' : 'Criar conta'}
          </button>

          <p className="mt-4 text-center text-xs text-sand-500">
            Já tens conta?{' '}
            <Link to="/login" className="text-curve-700 hover:underline">
              Iniciar sessão
            </Link>
          </p>
        </form>
      </div>
    </div>
  );
}
