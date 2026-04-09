import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import * as api from '../services/api';

const FIELDS = [
  { key: 'imap_server', label: 'Servidor IMAP', placeholder: 'outlook.office365.com' },
  { key: 'imap_port', label: 'Porta', placeholder: '993', type: 'number' },
  { key: 'imap_username', label: 'Utilizador', placeholder: 'email@example.com' },
  {
    key: 'imap_password',
    label: 'App Password',
    placeholder: '••••••••',
    type: 'password',
    help:
      'Não é a password da conta — é uma App Password gerada separadamente. ' +
      'Outlook/M365: activa MFA em account.microsoft.com → Security → Advanced ' +
      'security options → App passwords. Gmail: myaccount.google.com/apppasswords.',
  },
  { key: 'imap_folder', label: 'Pasta IMAP', placeholder: 'INBOX/Curve Receipts' },
  { key: 'sync_interval_minutes', label: 'Intervalo (min)', placeholder: '5', type: 'number' },
];

export default function CurveConfigPage() {
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState(null);

  useEffect(() => {
    api.getCurveConfig().then((res) => setForm(res.data ?? {})).catch(() => {});
  }, []);

  const handleChange = (key, value) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    setMessage(null);
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
      setMessage({ type: 'ok', text: res.message ?? 'Ligação bem-sucedida.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Configuração"
        description="Credenciais IMAP e parâmetros de sincronização"
      />

      <form onSubmit={handleSave} className="card max-w-xl animate-fade-in-up">
        <div className="mb-5 rounded-xl bg-amber-50 px-4 py-3 text-xs text-amber-800">
          <strong className="font-semibold">Importante:</strong> Outlook, Microsoft 365
          e Gmail já não aceitam a password normal da conta para acesso IMAP.
          Tens de gerar uma <em>App Password</em> (requer MFA / 2-step verification
          activada) e colar aqui no campo abaixo. Ver ajuda no campo{' '}
          <em>App Password</em>.
        </div>

        <div className="grid gap-5">
          {FIELDS.map(({ key, label, placeholder, type, help }) => (
            <label key={key} className="block">
              <span className="mb-1.5 block text-xs font-medium text-sand-500">
                {label}
              </span>
              <input
                type={type ?? 'text'}
                value={form[key] ?? ''}
                onChange={(e) => handleChange(key, e.target.value)}
                placeholder={placeholder}
                className="input"
              />
              {help && (
                <span className="mt-1.5 block text-xs leading-relaxed text-sand-500">
                  {help}
                </span>
              )}
            </label>
          ))}

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
