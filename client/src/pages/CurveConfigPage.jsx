import { useEffect, useState } from 'react';
import PageHeader from '../components/common/PageHeader';
import * as api from '../services/api';

const FIELDS = [
  {
    key: 'email',
    label: 'Email Embers',
    placeholder: 'email@example.com',
    type: 'email',
    help:
      'Email da conta Embers (NÃO é o email associado ao Curve Pay). ' +
      'O backend procura o utilizador Embers pelo email (que é único) ' +
      'e liga o CurveConfig ao respectivo user_id.',
  },
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
  { key: 'imap_username', label: 'Utilizador', placeholder: 'email@example.com' },
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
    setMessage(null);
    // Guard: the backend requires `email` to resolve the user_id that
    // scopes this config. Catch the empty case client-side so we don't
    // round-trip just to get a 400.
    if (!form.email?.trim()) {
      setMessage({ type: 'error', text: 'Preenche o campo "Email Embers" antes de guardar.' });
      return;
    }
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
