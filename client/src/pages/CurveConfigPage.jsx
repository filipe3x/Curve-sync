import { useCallback, useEffect, useRef, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import { useAuth } from '../contexts/AuthContext';
import * as api from '../services/api';

// Text fields only. `imap_folder` is rendered separately as a state-aware
// <select> so the user can't typo a folder path into existence — see
// docs/EMAIL.md → Config UX for the full rationale.
const FIELDS = [
  {
    key: 'imap_server',
    label: 'Servidor IMAP',
    placeholder: 'outlook.office365.com  ou  127.0.0.1',
  },
  {
    key: 'imap_port',
    label: 'Porta',
    placeholder: '993 (direto) / 1993 (proxy)',
    type: 'number',
  },
  {
    key: 'imap_username',
    label: 'Email Curve Pay',
    placeholder: 'email@example.com',
    help:
      'O email da conta que recebe os recibos do Curve Pay (Curve Receipts). ' +
      'É este email que o IMAP vai consultar para importar despesas.',
  },
  {
    key: 'imap_password',
    label: 'Password IMAP',
    placeholder: '••••••••',
    type: 'password',
    help:
      'NÃO é a password normal da conta. Caminho A (direto): cola a App ' +
      'Password de 16 chars gerada em account.microsoft.com → Security → ' +
      'Advanced security options → App passwords (requer MFA). Caminho B ' +
      '(proxy localhost): cola a encryption password do emailproxy.config ' +
      'do email-oauth2-proxy.',
  },
  { key: 'sync_interval_minutes', label: 'Intervalo (min)', placeholder: '5', type: 'number' },
];

// Debounce window for the folder dropdown auto-save. Short enough to feel
// instantaneous, long enough to coalesce multiple rapid selections (e.g.
// keyboard arrow navigation through the list) into one PUT.
const FOLDER_AUTOSAVE_MS = 300;

export default function CurveConfigPage() {
  const { user } = useAuth();
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [message, setMessage] = useState(null);
  // Folders loaded from POST /test-connection. Empty until the user
  // clicks "Testar ligação" — no auto-fetch on mount (see docs/EMAIL.md
  // → Anti-patterns rejected → "Auto-fetch on page mount").
  const [folderOptions, setFolderOptions] = useState([]);
  // Dedicated busy flag for folder auto-save so the button states stay
  // independent of the main Guardar flow.
  const [folderSaving, setFolderSaving] = useState(false);
  const folderSaveTimer = useRef(null);

  useEffect(() => {
    api.getCurveConfig().then((res) => setForm(res.data ?? {})).catch(() => {});
  }, []);

  // Clean up any pending debounce timer on unmount to avoid a late
  // setState into an unmounted component.
  useEffect(() => {
    return () => {
      if (folderSaveTimer.current) clearTimeout(folderSaveTimer.current);
    };
  }, []);

  const handleChange = (key, value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setMessage(null);
    setSaving(true);
    try {
      await api.updateCurveConfig(form);
      setMessage({ type: 'ok', text: 'Configuração guardada.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setMessage(null);
    try {
      const res = await api.testConnection();
      setFolderOptions(Array.isArray(res.folders) ? res.folders : []);
      setMessage({ type: 'ok', text: res.message ?? 'Ligação bem-sucedida.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  // Persist the folder pick as a side effect of the dropdown change —
  // debounced so rapid reselections coalesce into one PUT. Always sends
  // confirm_folder: true so the backend stamps imap_folder_confirmed_at.
  const autoSaveFolder = useCallback(
    (nextFolder) => {
      if (folderSaveTimer.current) clearTimeout(folderSaveTimer.current);
      folderSaveTimer.current = setTimeout(async () => {
        setFolderSaving(true);
        try {
          await api.updateCurveConfig({
            ...form,
            imap_folder: nextFolder,
            confirm_folder: true,
          });
          // Reflect the confirmation locally so the banner disappears
          // without waiting for a full refetch.
          setForm((prev) => ({
            ...prev,
            imap_folder: nextFolder,
            imap_folder_confirmed_at: new Date().toISOString(),
          }));
          setMessage({ type: 'ok', text: `Pasta "${nextFolder}" confirmada.` });
        } catch (err) {
          setMessage({ type: 'error', text: err.message });
        } finally {
          setFolderSaving(false);
        }
      }, FOLDER_AUTOSAVE_MS);
    },
    [form],
  );

  // "Manter INBOX" dismiss: confirm the current value (typically INBOX)
  // without opening the dropdown or requiring a folder list fetch.
  const handleDismissBanner = async () => {
    setFolderSaving(true);
    try {
      await api.updateCurveConfig({
        ...form,
        imap_folder: form.imap_folder || 'INBOX',
        confirm_folder: true,
      });
      setForm((prev) => ({
        ...prev,
        imap_folder: prev.imap_folder || 'INBOX',
        imap_folder_confirmed_at: new Date().toISOString(),
      }));
      setMessage({ type: 'ok', text: 'Pasta confirmada.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setFolderSaving(false);
    }
  };

  // Derived state for the folder picker. The staleness check is computed
  // on every render from form + folderOptions — no extra state needed.
  const currentFolder = form.imap_folder || 'INBOX';
  const folderIsConfirmed = Boolean(form.imap_folder_confirmed_at);
  const folderListLoaded = folderOptions.length > 0;
  const folderIsStale = folderListLoaded && !folderOptions.includes(currentFolder);
  const showBanner = !folderIsConfirmed || folderIsStale;

  return (
    <>
      <PageHeader
        title="Configuração"
        description="Credenciais IMAP e parâmetros de sincronização"
      />

      <form onSubmit={handleSave} className="card max-w-xl animate-fade-in-up">
        <div className="mb-5 rounded-xl bg-amber-50 px-4 py-3 text-xs leading-relaxed text-amber-800">
          <strong className="font-semibold">Microsoft 365 e Gmail já não aceitam a
          password normal da conta para IMAP.</strong> Há dois caminhos suportados:
          <ul className="mt-2 ml-4 list-disc space-y-1">
            <li>
              <strong>Caminho A (direto):</strong> servidor{' '}
              <code>outlook.office365.com</code>, porta <code>993</code>, TLS{' '}
              <strong>activo</strong>, password = App Password de 16 chars
              (requer MFA activada na conta).
            </li>
            <li>
              <strong>Caminho B (proxy localhost):</strong> servidor{' '}
              <code>127.0.0.1</code>, porta <code>1993</code>, TLS{' '}
              <strong>desligado</strong>, password = encryption password do{' '}
              <code>emailproxy.config</code> (requer <code>email-oauth2-proxy</code>{' '}
              a correr). Ver <code>docs/EMAIL.md</code>.
            </li>
          </ul>
        </div>

        <div className="grid gap-5">
          {/* Read-only: authenticated user's Embers account */}
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-sand-500">
              Conta Embers
            </span>
            <input
              type="email"
              value={user?.email ?? ''}
              disabled
              className="input bg-sand-50 text-sand-500"
            />
            <span className="mt-1.5 block text-xs leading-relaxed text-sand-500">
              Conta com que fizeste login. As despesas importadas
              ficam associadas a este utilizador. Não é necessariamente
              o email que recebe os recibos do Curve Pay.
            </span>
          </label>
          {FIELDS.map(({ key, label, placeholder, type, help }) => (
            <label key={key} className="block">
              <span className="mb-1.5 block text-xs font-medium text-sand-500">
                {label}
              </span>
              {key === 'imap_password' ? (
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form[key] ?? ''}
                    onChange={(e) => handleChange(key, e.target.value)}
                    placeholder={
                      form.has_imap_password && !form.imap_password
                        ? 'password guardada — deixa vazio para manter'
                        : placeholder
                    }
                    className="input pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-sand-400 hover:text-curve-600 transition-colors"
                    tabIndex={-1}
                  >
                    {showPassword ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4.5 w-4.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3.98 8.223A10.477 10.477 0 0 0 1.934 12c1.292 4.338 5.31 7.5 10.066 7.5.993 0 1.953-.138 2.863-.395M6.228 6.228A10.451 10.451 0 0 1 12 4.5c4.756 0 8.773 3.162 10.065 7.498a10.522 10.522 0 0 1-4.293 5.774M6.228 6.228 3 3m3.228 3.228 3.65 3.65m7.894 7.894L21 21m-3.228-3.228-3.65-3.65m0 0a3 3 0 1 0-4.243-4.243m4.242 4.242L9.88 9.88" />
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="h-4.5 w-4.5">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M2.036 12.322a1.012 1.012 0 0 1 0-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178Z" />
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                      </svg>
                    )}
                  </button>
                </div>
              ) : (
                <input
                  type={type ?? 'text'}
                  value={form[key] ?? ''}
                  onChange={(e) => handleChange(key, e.target.value)}
                  placeholder={placeholder}
                  className="input"
                />
              )}
              {help && (
                <span className="mt-1.5 block text-xs leading-relaxed text-sand-500">
                  {help}
                </span>
              )}
            </label>
          ))}

          {/* Folder picker — <select> if we have a loaded folder list,
              otherwise a read-only display with a hint to click "Testar
              ligação" first. Never a free-text input. */}
          <div className="block">
            <span className="mb-1.5 block text-xs font-medium text-sand-500">
              Pasta IMAP
            </span>
            {folderListLoaded ? (
              <select
                value={currentFolder}
                onChange={(e) => {
                  const next = e.target.value;
                  handleChange('imap_folder', next);
                  autoSaveFolder(next);
                }}
                disabled={folderSaving}
                className="input"
              >
                {folderIsStale && (
                  <option value={currentFolder} disabled className="text-red-600">
                    {currentFolder} (não existe — escolha outra)
                  </option>
                )}
                {folderOptions.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            ) : (
              <div className="input flex items-center justify-between bg-sand-50 text-sand-500">
                <span>{currentFolder}</span>
                <span className="text-xs">clica em «Testar ligação» para escolher</span>
              </div>
            )}
            <span className="mt-1.5 block text-xs leading-relaxed text-sand-500">
              A lista de pastas é obtida do servidor IMAP no momento do teste
              de ligação — nunca é hardcoded. A escolha é guardada
              automaticamente e pode ser alterada a qualquer momento.
            </span>
          </div>

          {/* Confirmation banner — fires when the folder hasn't been
              confirmed yet, or when the stored value no longer exists on
              the server. Colour shifts from amber (unconfirmed) to red
              (stale). Dismissable via "Manter INBOX" unless stale. */}
          {showBanner && (
            <div
              className={`rounded-xl px-4 py-3 text-xs leading-relaxed ${
                folderIsStale
                  ? 'bg-red-50 text-red-700'
                  : 'bg-amber-50 text-amber-800'
              }`}
            >
              {folderIsStale ? (
                <p>
                  A pasta actualmente configurada (
                  <code className="font-mono">{currentFolder}</code>) não existe no
                  servidor IMAP. Escolhe uma das pastas disponíveis acima — a
                  sincronização fica bloqueada até ser confirmada.
                </p>
              ) : (
                <p>
                  A pasta <code className="font-mono">{currentFolder}</code> ainda não
                  foi confirmada. Clica em <strong>Testar ligação</strong> para veres
                  as pastas disponíveis e escolher uma, ou mantém{' '}
                  <code className="font-mono">INBOX</code> como default.
                </p>
              )}
              {!folderIsStale && (
                <button
                  type="button"
                  onClick={handleDismissBanner}
                  disabled={folderSaving}
                  className="mt-2 rounded-lg bg-amber-200/60 px-3 py-1 text-xs font-medium text-amber-900 hover:bg-amber-200 disabled:opacity-50"
                >
                  {folderSaving ? 'A guardar…' : `Manter ${currentFolder}`}
                </button>
              )}
            </div>
          )}

          {/* TLS toggle — turn off only for loopback proxy (Caminho B) */}
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={form.imap_tls ?? true}
              onChange={(e) => handleChange('imap_tls', e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-sand-300 text-curve-700 focus:ring-curve-500"
            />
            <span className="text-sm text-sand-700">
              Usar TLS
              <span className="mt-0.5 block text-xs text-sand-500">
                Liga sempre excepto para o proxy localhost (Caminho B).
                Desligar contra um host não-loopback é recusado pelo servidor.
              </span>
            </span>
          </label>

          {/* Sync enabled toggle */}
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={form.sync_enabled ?? false}
              onChange={(e) => handleChange('sync_enabled', e.target.checked)}
              className="h-4 w-4 rounded border-sand-300 text-curve-700 focus:ring-curve-500"
            />
            <span className="text-sm text-sand-700">Sincronização automática activa</span>
          </label>
        </div>

        {/* Messages */}
        {message && (
          <div
            className={`mt-5 rounded-xl px-4 py-3 text-sm transition-opacity duration-300 ${
              message.type === 'ok'
                ? 'bg-emerald-50 text-emerald-700'
                : 'bg-red-50 text-curve-700'
            }`}
          >
            {message.text}
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex gap-3">
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? 'A guardar…' : 'Guardar'}
          </button>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing}
            className="btn-secondary"
          >
            {testing ? 'A testar…' : 'Testar ligação'}
          </button>
        </div>
      </form>
    </>
  );
}
