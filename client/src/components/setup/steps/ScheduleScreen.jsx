/**
 * Step 5 — Schedule / finish.
 *
 * Functional only: toggle for automatic sync + interval select, two
 * buttons (concluir / saltar). On concluir we PUT /curve/config with
 * the chosen flags and redirect to /curve/config.
 */
import { useState } from 'react';
import WizardLayout from '../WizardLayout.jsx';

const INTERVAL_OPTIONS = [
  { value: 5, label: 'Cada 5 minutos' },
  { value: 15, label: 'Cada 15 minutos' },
  { value: 30, label: 'Cada 30 minutos' },
  { value: 60, label: 'Cada hora' },
];

export default function ScheduleScreen({ loading, error, onFinish, onSkip }) {
  const [syncEnabled, setSyncEnabled] = useState(true);
  const [interval, setIntervalValue] = useState(15);

  const finish = () => {
    onFinish({ syncEnabled, intervalMinutes: interval });
  };

  return (
    <WizardLayout
      id="schedule"
      eyebrow="Passo 5 de 5"
      title="Sincronização automática?"
      subtitle="Podemos ir buscar novos recibos em segundo plano. Podes mudar isto depois na página de configuração."
      error={error}
      actions={
        <>
          <button
            type="button"
            className="btn-primary"
            onClick={finish}
            disabled={loading}
          >
            {loading ? 'A guardar…' : 'Concluir'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onSkip}
            disabled={loading}
          >
            Saltar
          </button>
        </>
      }
    >
      <div className="space-y-5">
        <label className="flex items-start gap-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={syncEnabled}
            onChange={(e) => setSyncEnabled(e.target.checked)}
            className="mt-1 w-4 h-4 accent-curve-700"
          />
          <span>
            <span className="block text-sm font-medium text-sand-900">
              Ativar sincronização automática
            </span>
            <span className="block text-sm text-sand-600">
              Vamos verificar novos emails no intervalo escolhido.
            </span>
          </span>
        </label>

        <div>
          <label
            htmlFor="setup-interval"
            className="block text-sm font-medium text-sand-800 mb-1"
          >
            Intervalo
          </label>
          <select
            id="setup-interval"
            value={interval}
            onChange={(e) => setIntervalValue(Number(e.target.value))}
            disabled={!syncEnabled}
            className="input disabled:opacity-50"
          >
            {INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </div>
    </WizardLayout>
  );
}
