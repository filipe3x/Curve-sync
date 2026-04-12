/**
 * Step 4 — Success.
 *
 * Tokens are stored, the MSAL account is persisted in CurveConfig.
 * We show a single checkmark and the canonical mailbox address
 * returned by MSAL (which may differ from what the user typed if
 * they use an alias).
 */
import { CheckCircle2 } from 'lucide-react';
import WizardLayout from '../WizardLayout.jsx';

export default function SuccessScreen({ email, onContinue }) {
  return (
    <WizardLayout
      id="success"
      eyebrow="Passo 4 de 6"
      title="Conta ligada"
      subtitle="A Microsoft confirmou o acesso. A partir de agora, conseguimos ler os recibos do Curve Card na tua caixa de entrada."
      actions={
        <button type="button" className="btn-primary" onClick={onContinue}>
          Continuar
        </button>
      }
    >
      <div className="flex items-center gap-4 p-4 rounded-2xl bg-sand-50 border border-sand-200">
        <CheckCircle2 className="w-8 h-8 text-curve-700 shrink-0" strokeWidth={1.75} />
        <div className="min-w-0">
          <p className="text-sm text-sand-600 uppercase tracking-[0.16em]">Mailbox</p>
          <p className="text-base font-medium text-sand-950 truncate">
            {email || 'conta Microsoft'}
          </p>
        </div>
      </div>
    </WizardLayout>
  );
}
