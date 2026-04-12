/**
 * Step 3 — Device Authorization Grant code entry.
 *
 * The wizard container has already kicked off the DAG and is polling
 * the backend every ~3 s. This screen just surfaces the code + URL
 * + QR and a cancel button. It does NOT poll on its own.
 *
 * On success, the parent advances to SuccessScreen. On error it
 * surfaces `error` in the red slot.
 */
import { QRCodeSVG } from 'qrcode.react';
import { ExternalLink, Loader2 } from 'lucide-react';
import WizardLayout from '../WizardLayout.jsx';

export default function DeviceCodeScreen({
  codeInfo,
  pollStatus,
  error,
  onCancel,
}) {
  const userCode = codeInfo?.userCode || '········';
  const uri = codeInfo?.verificationUri || 'https://microsoft.com/devicelogin';

  return (
    <WizardLayout
      id="code"
      eyebrow="Passo 3 de 6"
      title="Abre a Microsoft e introduz este código"
      subtitle="Podes abrir a página no teu telemóvel (scan do QR) ou num novo separador. Voltamos automaticamente quando concluíres."
      error={error}
      actions={
        <>
          <button type="button" className="btn-secondary" onClick={onCancel}>
            Cancelar
          </button>
          <a
            href={uri}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary inline-flex items-center gap-2"
          >
            <ExternalLink className="w-4 h-4" strokeWidth={1.75} />
            Abrir página
          </a>
          <span className="ml-auto inline-flex items-center gap-2 text-sm text-sand-600">
            {pollStatus === 'pending' && (
              <>
                <Loader2 className="w-4 h-4 animate-spin" strokeWidth={1.75} />
                À espera da confirmação…
              </>
            )}
          </span>
        </>
      }
    >
      <div className="flex flex-col md:flex-row items-center gap-6">
        {/* Big code */}
        <div className="flex-1 w-full text-center md:text-left">
          <p className="text-xs uppercase tracking-[0.18em] text-sand-600 mb-2">
            Código
          </p>
          <p
            className="font-mono text-4xl md:text-5xl tracking-[0.15em] text-sand-950 select-all"
            aria-live="polite"
          >
            {userCode}
          </p>
          <p className="mt-4 text-sm text-sand-700 break-all">
            URL: <span className="font-medium text-sand-900">{uri}</span>
          </p>
        </div>

        {/* QR */}
        <div className="shrink-0 p-3 bg-white border border-sand-200 rounded-2xl">
          <QRCodeSVG
            value={uri}
            size={148}
            level="M"
            bgColor="#ffffff"
            fgColor="#2f2a24"
          />
        </div>
      </div>
    </WizardLayout>
  );
}
