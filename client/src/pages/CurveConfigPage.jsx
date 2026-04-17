/**
 * Curve Sync configuration page — post-wizard settings view.
 *
 * Pre-wizard this file used to be a full-blown IMAP credentials form
 * with App Password fields, proxy hints and a password toggle. Now
 * that /curve/setup is the canonical onboarding path, this page is
 * a dashboard-style editor for the three things that remain
 * user-tunable after the DAG runs:
 *
 *   1. Connection — read-only status of the bound OAuth account with
 *      a "Reautorizar" link back into the wizard.
 *   2. Folder     — pick / confirm the IMAP folder that holds the
 *      Curve receipts (same state machine as the wizard's step 5).
 *   3. Schedule   — enable/disable auto-sync + choose the interval.
 *
 * The page also surfaces the last-sync stats as read-only
 * informational cards. There is intentionally no "delete config"
 * button — a destructive action belongs behind an explicit flow in
 * a future iteration.
 *
 * Migrating away from the legacy manual form means users still on
 * App Password cannot edit their credentials here. That is the
 * designed trade-off: the wizard is the single entry point, and
 * App-Password holdouts either keep running untouched or move to
 * OAuth via the wizard. See docs/EMAIL_AUTH_MVP.md §7.1.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/common/PageHeader';
import { useAuth } from '../contexts/AuthContext';
import * as api from '../services/api';

// Debounce window for the folder dropdown auto-save. Short enough to
// feel instantaneous, long enough to coalesce rapid keyboard navigation
// through the list into one PUT.
const FOLDER_AUTOSAVE_MS = 300;

const SYNC_INTERVAL_OPTIONS = [
  { value: 5, label: '5 minutos' },
  { value: 15, label: '15 minutos' },
  { value: 30, label: '30 minutos' },
  { value: 60, label: '1 hora' },
];

function formatDateTime(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleString('pt-PT', {
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return String(value);
  }
}

export default function CurveConfigPage() {
  const { user } = useAuth();
  const [config, setConfig] = useState({});
  const [oauthStatus, setOauthStatus] = useState(null);
  const [folderOptions, setFolderOptions] = useState([]);
  const [testing, setTesting] = useState(false);
  const [folderSaving, setFolderSaving] = useState(false);
  const [schedSaving, setSchedSaving] = useState(false);
  const [message, setMessage] = useState(null);
  const folderSaveTimer = useRef(null);

  // ----- Initial load ------------------------------------------------
  useEffect(() => {
    api
      .getCurveConfig()
      .then((res) => setConfig(res.data ?? {}))
      .catch(() => {});
    api
      .getOAuthStatus()
      .then(setOauthStatus)
      .catch(() => setOauthStatus({ connected: false }));
  }, []);

  // Clean up any pending debounce timer on unmount to avoid a late
  // setState into an unmounted component.
  useEffect(() => {
    return () => {
      if (folderSaveTimer.current) clearTimeout(folderSaveTimer.current);
    };
  }, []);

  // ----- Folder: fetch list via /test-connection --------------------
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

  // ----- Folder: persist pick (debounced, always confirms) -----------
  const autoSaveFolder = useCallback((nextFolder) => {
    if (folderSaveTimer.current) clearTimeout(folderSaveTimer.current);
    folderSaveTimer.current = setTimeout(async () => {
      setFolderSaving(true);
      setMessage(null);
      try {
        await api.updateCurveConfig({
          imap_folder: nextFolder,
          confirm_folder: true,
        });
        setConfig((prev) => ({
          ...prev,
          imap_folder: nextFolder,
          imap_folder_confirmed_at: new Date().toISOString(),
        }));
        setMessage({
          type: 'ok',
          text: `Pasta "${nextFolder}" confirmada.`,
        });
      } catch (err) {
        setMessage({ type: 'error', text: err.message });
      } finally {
        setFolderSaving(false);
      }
    }, FOLDER_AUTOSAVE_MS);
  }, []);

  // "Manter pasta actual" dismiss — confirms the current value without
  // reopening the dropdown / fetching the folder list.
  const handleDismissBanner = async () => {
    setFolderSaving(true);
    setMessage(null);
    try {
      await api.updateCurveConfig({
        imap_folder: config.imap_folder || 'INBOX',
        confirm_folder: true,
      });
      setConfig((prev) => ({
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

  // ----- Schedule: immediate save on toggle / select change ---------
  const saveSchedule = async (patch) => {
    setSchedSaving(true);
    setMessage(null);
    try {
      await api.updateCurveConfig(patch);
      setConfig((prev) => ({ ...prev, ...patch }));
      setMessage({ type: 'ok', text: 'Agenda actualizada.' });
    } catch (err) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSchedSaving(false);
    }
  };

  // ----- Derived state ----------------------------------------------
  const currentFolder = config.imap_folder || 'INBOX';
  const folderIsConfirmed = Boolean(config.imap_folder_confirmed_at);
  const folderListLoaded = folderOptions.length > 0;
  const folderIsStale =
    folderListLoaded && !folderOptions.includes(currentFolder);
  const showFolderBanner = !folderIsConfirmed || folderIsStale;
  const connected = Boolean(oauthStatus?.connected);
  const providerLabel =
    oauthStatus?.provider === 'microsoft' ? 'Microsoft' : oauthStatus?.provider;

  // Three-state auth classification:
  //   - fresh:        user never connected (no oauth_provider, no legacy pw)
  //   - broken:       oauth_provider set but `connected=false` — the cache
  //                   was wiped, tokens expired, consent revoked, etc.
  //                   This is the "re-auth" state and is the only one that
  //                   should gate inputs off + light up the warning banner.
  //   - ok:           fully connected, either OAuth (connected=true) or
  //                   App Password (no oauth_provider but imap_password set)
  //
  // We distinguish broken vs fresh because a fresh user also sees
  // `connected=false`, but disabling the toggles on them is pointless
  // noise — they just need to run the wizard. Broken users by contrast
  // need the inputs off AND a prominent recovery CTA.
  const authBroken = Boolean(oauthStatus?.provider) && !connected;
  const authFresh =
    oauthStatus !== null && !oauthStatus?.provider && !config.has_imap_password;

  return (
    <>
      <PageHeader
        title="Configuração"
        description="Ligação, pasta e agenda de sincronização"
      />

      {/*
        Broken-auth banner — shown ONLY when the user was previously
        connected via OAuth and the server says `connected=false` now
        (cache wiped, tokens expired, consent revoked). Fresh users
        never see this because they land on the "Ligação" card below
        which already has a clear "Abrir assistente" CTA. This is the
        high-level warning the re-auth test path was missing.
      */}
      {authBroken && (
        <Link
          to="/curve/setup"
          className="mb-5 block max-w-xl rounded-2xl border border-red-200 bg-red-50 px-5 py-4 hover:bg-red-100 transition-colors animate-fade-in-up"
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <p className="text-sm font-semibold text-red-900">
                Ligação à conta Microsoft partida
              </p>
              <p className="mt-1 text-sm text-red-800/90">
                O token de acesso para{' '}
                <code className="font-mono text-red-900">
                  {oauthStatus?.email || 'a tua conta'}
                </code>{' '}
                já não é válido. A sincronização está suspensa até
                reautorizares.
              </p>
            </div>
            <span className="shrink-0 text-sm font-medium text-red-900 underline underline-offset-4">
              Reautorizar →
            </span>
          </div>
        </Link>
      )}

      {/* ----- Connection status card ----- */}
      <section className="card max-w-xl mb-5 animate-fade-in-up">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-sand-500">
          Ligação
        </h2>

        {oauthStatus === null ? (
          <p className="mt-3 text-sm text-sand-400">A verificar…</p>
        ) : connected ? (
          <div className="mt-3 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-lg font-semibold text-sand-900">
                {oauthStatus.email}
              </p>
              <p className="mt-1 text-xs text-sand-500">
                Ligada via <strong>{providerLabel}</strong> — token gerido
                pelo servidor, sem App Passwords.
              </p>
            </div>
            <Link
              to="/curve/setup"
              className="shrink-0 text-sm font-medium text-curve-700 underline underline-offset-4 hover:text-curve-900"
            >
              Reautorizar →
            </Link>
          </div>
        ) : authBroken ? (
          // Was connected, broken now. Keep the email visible so the
          // user sees which account needs re-authorizing — the top
          // banner already carries the red CTA so we don't repeat it.
          <div className="mt-3">
            <p className="text-lg font-semibold text-sand-900">
              {oauthStatus.email}
            </p>
            <p className="mt-1 text-xs text-red-700">
              Ligada via <strong>{providerLabel}</strong>, mas o token expirou
              ou foi revogado. Reautoriza no banner acima para retomar a
              sincronização.
            </p>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-sm text-sand-700">
              Nenhuma conta Microsoft ligada. Corre o assistente para
              autorizar a leitura dos recibos do Curve Pay.
            </p>
            <Link
              to="/curve/setup"
              className="mt-3 inline-block rounded-xl bg-curve-700 px-4 py-2 text-sm font-medium text-white hover:bg-curve-800"
            >
              Abrir assistente
            </Link>
          </div>
        )}

        <p className="mt-4 text-xs text-sand-400">
          Autenticado como <code className="font-mono">{user?.email ?? '—'}</code>.
          As despesas importadas ficam associadas a este utilizador.
        </p>
      </section>

      {/* ----- Folder card ----- */}
      <section className="card max-w-xl mb-5 animate-fade-in-up">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-sand-500">
              Pasta IMAP
            </h2>
            <p className="mt-1 text-xs text-sand-500">
              {authBroken || authFresh
                ? 'A escolha da pasta fica disponível depois de autorizares a conta.'
                : 'Onde o servidor procura os recibos. Só mexe aqui se mudares regras no teu cliente de email.'}
            </p>
          </div>
          <button
            type="button"
            onClick={handleTest}
            disabled={testing || authBroken || authFresh}
            title={
              authBroken
                ? 'Reautoriza a conta Microsoft antes de testar a ligação'
                : authFresh
                ? 'Liga uma conta antes de testar a ligação'
                : undefined
            }
            className="btn-secondary shrink-0 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? 'A testar…' : 'Testar ligação'}
          </button>
        </div>

        <div className="mt-4">
          {folderListLoaded ? (
            <select
              value={currentFolder}
              onChange={(e) => {
                const next = e.target.value;
                setConfig((prev) => ({ ...prev, imap_folder: next }));
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
              <span className="truncate">{currentFolder}</span>
              <span className="ml-2 shrink-0 text-xs">
                clica em «Testar ligação» para escolher
              </span>
            </div>
          )}
        </div>

        {showFolderBanner && (
          <div
            className={`mt-4 rounded-xl px-4 py-3 text-xs leading-relaxed ${
              folderIsStale
                ? 'bg-red-50 text-red-700'
                : 'bg-amber-50 text-amber-800'
            }`}
          >
            {folderIsStale ? (
              <p>
                A pasta actualmente configurada (
                <code className="font-mono">{currentFolder}</code>) não
                existe no servidor IMAP. Escolhe uma das pastas disponíveis
                acima — a sincronização fica bloqueada até ser confirmada.
              </p>
            ) : (
              <p>
                A pasta <code className="font-mono">{currentFolder}</code>{' '}
                ainda não foi confirmada. Clica em{' '}
                <strong>Testar ligação</strong> para veres as pastas
                disponíveis, ou mantém a escolha actual.
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
      </section>

      {/* ----- Schedule card ----- */}
      <section className="card max-w-xl mb-5 animate-fade-in-up">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-sand-500">
          Agenda de sincronização
        </h2>

        {(authBroken || authFresh) && (
          <p className="mt-3 rounded-lg bg-sand-50 px-3 py-2 text-xs text-sand-600">
            A agenda automática está suspensa porque não há uma ligação
            válida ao servidor de email. Reautoriza a conta para voltar
            a activar.
          </p>
        )}

        <label className="mt-4 flex items-start gap-3">
          <input
            type="checkbox"
            checked={config.sync_enabled ?? false}
            onChange={(e) =>
              saveSchedule({ sync_enabled: e.target.checked })
            }
            disabled={schedSaving || authBroken || authFresh}
            className="mt-0.5 h-4 w-4 rounded border-sand-300 text-curve-700 focus:ring-curve-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span
            className={`text-sm ${
              authBroken || authFresh ? 'text-sand-400' : 'text-sand-700'
            }`}
          >
            Sincronização automática activa
            <span className="mt-0.5 block text-xs text-sand-500">
              Quando activa, o servidor verifica recibos novos no intervalo
              escolhido abaixo. Quando desligada, só corre ao clicar em
              «Sincronizar agora» no dashboard.
            </span>
          </span>
        </label>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs font-medium text-sand-500">
            Intervalo
          </span>
          <select
            value={config.sync_interval_minutes ?? 5}
            onChange={(e) =>
              saveSchedule({ sync_interval_minutes: Number(e.target.value) })
            }
            disabled={
              schedSaving ||
              !(config.sync_enabled ?? false) ||
              authBroken ||
              authFresh
            }
            className="input disabled:cursor-not-allowed disabled:opacity-50"
          >
            {SYNC_INTERVAL_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>

        {/*
          Day-of-month cut-off for the expense cycle. Drives: the
          dashboard "este mês" totals, the /categories/stats windows,
          the uncategorised count card, and the first-sync imap_since
          fallback. Clamped to [1, 28] to avoid Feb overflow. See
          docs/expense-tracking.md → Custom Monthly Cycle.
        */}
        <label className="mt-5 block">
          <span className="mb-1.5 block text-xs font-medium text-sand-500">
            Dia de início do ciclo
          </span>
          <select
            value={config.sync_cycle_day ?? 22}
            onChange={(e) =>
              saveSchedule({ sync_cycle_day: Number(e.target.value) })
            }
            disabled={schedSaving || authBroken || authFresh}
            className="input disabled:cursor-not-allowed disabled:opacity-50"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <span className="mt-1.5 block text-xs text-sand-500">
            Dia do mês em que arranca o ciclo de despesas — por defeito
            22, alinhado com o ciclo salarial. Aplica-se ao dashboard,
            categorias e à primeira sincronização.
          </span>
        </label>
      </section>

      {/* ----- Stats card ----- */}
      <section className="card max-w-xl mb-5 animate-fade-in-up">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-sand-500">
          Estado
        </h2>

        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <dt className="text-xs text-sand-400">Último sync</dt>
            <dd className="mt-1 font-medium text-sand-900">
              {formatDateTime(config.last_sync_at)}
            </dd>
            {/*
              Status sub-label: the `config.last_sync_status` field is
              historically authoritative (it's what the orchestrator
              wrote after the last run), but it does NOT know about the
              *current* live state of the OAuth cache. When the cache
              gets wiped mid-cycle the last stored status may still say
              'ok' from the previous run, which is misleading. Override
              the label with "ligação partida" whenever the live auth
              status contradicts the stored sync status, so the card
              matches the reality shown by the banner above.
            */}
            {authBroken ? (
              <dd className="mt-0.5 text-xs text-red-600">
                ligação partida
              </dd>
            ) : (
              config.last_sync_status && (
                <dd
                  className={`mt-0.5 text-xs ${
                    config.last_sync_status === 'error'
                      ? 'text-red-600'
                      : 'text-emerald-700'
                  }`}
                >
                  {config.last_sync_status === 'error' ? 'erro' : 'ok'}
                </dd>
              )
            )}
          </div>
          <div>
            <dt className="text-xs text-sand-400">Último recibo</dt>
            <dd className="mt-1 font-medium text-sand-900">
              {formatDateTime(config.last_email_at)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-sand-400">Emails processados</dt>
            <dd className="mt-1 font-medium text-sand-900">
              {config.emails_processed_total ?? 0}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-sand-400">Pasta</dt>
            <dd className="mt-1 font-medium text-sand-900 truncate">
              {currentFolder}
            </dd>
          </div>
        </dl>
      </section>

      {/* ----- Inline status message ----- */}
      {message && (
        <div
          className={`max-w-xl rounded-xl px-4 py-3 text-sm transition-opacity duration-300 ${
            message.type === 'ok'
              ? 'bg-emerald-50 text-emerald-700'
              : 'bg-red-50 text-curve-700'
          }`}
        >
          {message.text}
        </div>
      )}
    </>
  );
}
