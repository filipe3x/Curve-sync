/**
 * Step 2 — Trust / consent explainer.
 *
 * Tells the user what we will (and will not) read, then starts the
 * Device Authorization Grant when they hit "Autorizar".
 */
import { Eye, Lock, ShieldCheck } from 'lucide-react';
import WizardLayout from '../WizardLayout.jsx';

const BULLETS = [
  {
    icon: Eye,
    label: 'Só leitura',
    text: 'Vamos apenas ler os emails do Curve Card. Não enviamos, não apagamos, não movemos nada.',
  },
  {
    icon: ShieldCheck,
    label: 'Direto para a Microsoft',
    text: 'A autorização é feita na página oficial da Microsoft. Nunca vemos a tua palavra-passe.',
  },
  {
    icon: Lock,
    label: 'Podes desligar quando quiseres',
    text: 'Revogas o acesso pela página de segurança da Microsoft ou desativas a sincronização aqui.',
  },
];

export default function TrustScreen({
  email,
  loading,
  error,
  onContinue,
  onBack,
}) {
  return (
    <WizardLayout
      id="trust"
      eyebrow="Passo 2 de 5"
      title="Vamos pedir autorização à Microsoft"
      subtitle={`Para ligar ${email || 'a tua conta'}, precisamos que abras a página da Microsoft e aproves um código curto. Não saímos deste assistente.`}
      error={error}
      actions={
        <>
          <button
            type="button"
            className="btn-primary"
            onClick={onContinue}
            disabled={loading}
          >
            {loading ? 'A preparar…' : 'Autorizar'}
          </button>
          <button
            type="button"
            className="btn-secondary"
            onClick={onBack}
            disabled={loading}
          >
            Voltar
          </button>
        </>
      }
    >
      <ul className="space-y-3">
        {BULLETS.map(({ icon: Icon, label, text }) => (
          <li key={label} className="flex gap-3 items-start">
            <span className="shrink-0 w-9 h-9 rounded-full bg-sand-100 border border-sand-200 flex items-center justify-center">
              <Icon className="w-4 h-4 text-sand-700" strokeWidth={1.75} />
            </span>
            <div>
              <p className="text-sm font-medium text-sand-900">{label}</p>
              <p className="text-sm text-sand-700 leading-snug">{text}</p>
            </div>
          </li>
        ))}
      </ul>
    </WizardLayout>
  );
}
