/**
 * Step 4 — Pick receipts folder.
 *
 * Premium-quiet variant: the folder list is pre-fetched by the wizard
 * container the moment the DAG completes (see CurveSetupPage.jsx →
 * `prefetchFolders`). By the time the user lands here, the list is
 * already in state and the UI just renders — no blocking spinner.
 *
 * If the prefetch is somehow still in flight (very fast users, slow
 * IMAP), we show a shimmer skeleton instead of a spinner, which feels
 * calmer. If the prefetch errored, we show a retry button wired to
 * the container's `onRetry`.
 *
 * The match heuristic (`suggestReceiptsFolder`) pre-selects the most
 * likely folder:
 *   1. Any folder whose name contains "curve" (case-insensitive);
 *      deepest path wins so "Finanças/Curve" beats "INBOX/Curve".
 *   2. Otherwise, any folder containing "receipt" or "recib".
 *   3. Otherwise, "INBOX" if present.
 *   4. Otherwise, the first folder the server returned.
 *
 * Intentionally stubbed for a future polish pass:
 *   - "Não vejo a minha pasta" secondary link is rendered but disabled
 *     (will open a mini folder explorer / free-text fallback — see
 *     docs/WIZARD_POLISH_BACKLOG.md §8b).
 *   - Per-folder preview ("47 recibos encontrados, mais recente
 *     ontem") — needs a backend SEARCH endpoint, also in the backlog.
 */
import { motion, useReducedMotion } from 'motion/react';
import {
  Folder,
  FolderCheck,
  FolderSearch,
  Sparkle,
  RefreshCw,
} from 'lucide-react';
import WizardLayout from '../WizardLayout.jsx';
import { suggestReceiptsFolder } from './folderHeuristic.js';

// Re-exported so CurveSetupPage and the server-side smoke test can
// both reach the heuristic without depending on React.
export { suggestReceiptsFolder };

export default function PickFolderScreen({
  folders,
  foldersLoading,
  foldersError,
  selectedFolder,
  onSelectFolder,
  onRetry,
  onContinue,
  loading,
  error,
}) {
  const recommended =
    folders && folders.length > 0 ? suggestReceiptsFolder(folders) : null;
  const hasFolders = Array.isArray(folders) && folders.length > 0;

  return (
    <WizardLayout
      id="pick-folder"
      eyebrow="Passo 5 de 6"
      title="Onde estão os recibos do Curve?"
      subtitle="Vamos ler apenas os emails desta pasta. Já sugerimos a mais provável — confirma ou escolhe outra."
      error={error || foldersError}
      actions={
        <>
          <button
            type="button"
            className="btn-primary"
            disabled={
              !selectedFolder || loading || foldersLoading || !!foldersError
            }
            onClick={() => onContinue(selectedFolder)}
          >
            {loading ? 'A guardar…' : 'Continuar'}
          </button>
          {foldersError && (
            <button
              type="button"
              className="btn-secondary inline-flex items-center gap-2"
              onClick={onRetry}
            >
              <RefreshCw className="w-4 h-4" strokeWidth={1.75} />
              Tentar de novo
            </button>
          )}
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1.5 text-sm text-sand-500 underline underline-offset-4 decoration-sand-300 cursor-not-allowed"
            title="Em breve"
            disabled
          >
            <FolderSearch className="w-4 h-4" strokeWidth={1.75} />
            Não vejo a minha pasta
          </button>
        </>
      }
    >
      {foldersLoading && <FolderSkeleton />}
      {!foldersLoading && hasFolders && (
        <FolderList
          folders={folders}
          selected={selectedFolder}
          recommended={recommended}
          onSelect={onSelectFolder}
        />
      )}
      {!foldersLoading && !hasFolders && !foldersError && (
        <div className="rounded-xl border border-dashed border-sand-300 bg-sand-50 p-4 text-sm text-sand-700">
          A tua mailbox parece não ter pastas visíveis. Vamos usar{' '}
          <code className="text-sand-900">INBOX</code> por agora — podes
          mudar depois na página de configuração.
        </div>
      )}
    </WizardLayout>
  );
}

/**
 * Placeholder rows — keeps the rhythm of the final list so the layout
 * doesn't jump when the real folders arrive. The stagger reads as
 * "the server is talking to us" without the twitchiness of a spinner.
 */
function FolderSkeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-live="polite">
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          className="h-12 rounded-xl bg-sand-100 animate-pulse"
          style={{ animationDelay: `${i * 100}ms` }}
        />
      ))}
      <span className="sr-only">A carregar pastas da tua mailbox…</span>
    </div>
  );
}

function FolderList({ folders, selected, recommended, onSelect }) {
  const reduced = useReducedMotion();
  return (
    <motion.ul
      className="max-h-72 overflow-y-auto space-y-1.5 pr-1 -mr-1"
      role="radiogroup"
      aria-label="Pastas disponíveis"
      initial={reduced ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, ease: 'easeOut' }}
    >
      {folders.map((folder, idx) => {
        const isSelected = folder === selected;
        const isRecommended = folder === recommended;
        const itemTransition = reduced
          ? { duration: 0 }
          : { duration: 0.3, ease: 'easeOut', delay: 0.04 * idx };
        return (
          <motion.li
            key={folder}
            initial={reduced ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={itemTransition}
          >
            <label
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                isSelected
                  ? 'border-curve-500 bg-curve-50 shadow-sm'
                  : 'border-sand-200 bg-white hover:border-sand-300 hover:bg-sand-50'
              }`}
            >
              <input
                type="radio"
                name="setup-folder"
                value={folder}
                checked={isSelected}
                onChange={() => onSelect(folder)}
                className="sr-only"
              />
              <span
                className={`shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-colors ${
                  isSelected
                    ? 'bg-curve-100 text-curve-800'
                    : 'bg-sand-100 text-sand-600'
                }`}
              >
                {isSelected ? (
                  <FolderCheck className="w-4 h-4" strokeWidth={1.75} />
                ) : (
                  <Folder className="w-4 h-4" strokeWidth={1.75} />
                )}
              </span>
              <span className="flex-1 min-w-0 text-sm font-medium text-sand-900 truncate">
                {folder}
              </span>
              {isRecommended && (
                <span className="shrink-0 inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-curve-700 text-white text-[11px] font-medium uppercase tracking-wide">
                  <Sparkle className="w-3 h-3" strokeWidth={2} />
                  Sugerida
                </span>
              )}
            </label>
          </motion.li>
        );
      })}
    </motion.ul>
  );
}
