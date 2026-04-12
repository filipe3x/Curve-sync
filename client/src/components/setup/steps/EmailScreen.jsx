/**
 * Step 1 — Email input.
 *
 * Strictly functional: a single input + primary button + back link.
 * On submit, the wizard container calls POST /curve/oauth/check-email
 * and either advances to the trust screen (supported provider) or
 * shows the "use App Password" fallback message.
 */
import { useState } from 'react';
import WizardLayout from '../WizardLayout.jsx';

export default function EmailScreen({
  initialEmail,
  loading,
  error,
  onSubmit,
  onBack,
  onUseAppPassword,
}) {
  const [value, setValue] = useState(initialEmail || '');

  const submit = (e) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  };

  return (
    <WizardLayout
      id="email"
      eyebrow="Passo 1 de 5"
      title="Qual é o teu email?"
      subtitle="Vamos ver se a tua conta suporta autorização direta (Microsoft pessoal) ou se precisas do formulário manual."
      error={error}
      actions={
        <>
          <button
            type="submit"
            form="email-form"
            className="btn-primary"
            disabled={loading || !value.trim()}
          >
            {loading ? 'A verificar…' : 'Continuar'}
          </button>
          <button type="button" className="btn-secondary" onClick={onBack}>
            Voltar
          </button>
          <button
            type="button"
            className="ml-auto text-sm text-sand-600 hover:text-sand-900 underline underline-offset-4"
            onClick={onUseAppPassword}
          >
            Usar App Password
          </button>
        </>
      }
    >
      <form id="email-form" onSubmit={submit}>
        <label htmlFor="setup-email" className="block text-sm font-medium text-sand-800 mb-1">
          Email
        </label>
        <input
          id="setup-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          autoFocus
          placeholder="tu@outlook.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="input"
          disabled={loading}
        />
      </form>
    </WizardLayout>
  );
}
