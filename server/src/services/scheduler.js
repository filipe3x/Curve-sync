import cron from 'node-cron';
import CurveConfig from '../models/CurveConfig.js';
import { syncEmails, isSyncing, SyncConflictError } from './syncOrchestrator.js';
import { createImapReader } from './imapReader.js';
import { decrypt } from './crypto.js';

// ---------- State ----------

let task = null;
let lastRunAt = null;

// ---------- Public API ----------

/**
 * Start the scheduler. Runs every `intervalMinutes` minutes, iterating
 * over all CurveConfigs with `sync_enabled: true` and calling
 * `syncEmails()` sequentially for each. Configs whose sync is already
 * in progress (per-user lock) are silently skipped.
 */
export function startScheduler(intervalMinutes = 5) {
  stopScheduler();
  const expr = `*/${intervalMinutes} * * * *`;
  task = cron.schedule(expr, () => runAll());
  console.log(`Scheduler started: every ${intervalMinutes} min (${expr})`);
}

export function stopScheduler() {
  if (task) {
    task.stop();
    task = null;
    console.log('Scheduler stopped.');
  }
}

export function getSchedulerStatus() {
  return {
    running: task !== null,
    lastRunAt,
  };
}

// ---------- Gate ----------

// The cron tick fires every 5 min, but each config carries its own
// `sync_interval_minutes` (5 / 15 / 30 / 60). Gate by wall-clock minute:
// a config runs only when the current minute is divisible by its
// interval — 15 → :00/:15/:30/:45, 30 → :00/:30, 60 → :00. Keeps the
// scheduler single-cron while honouring per-user cadence.
export function shouldRunAtTick(config, tickMinute) {
  const raw = config?.sync_interval_minutes;
  const parsed = Number(raw);
  // 0 / negative values are rejected explicitly (can't do modulo by 0).
  // NaN / undefined fall back to the 5-min default.
  if (raw != null && Number.isFinite(parsed) && parsed <= 0) return false;
  const interval = Number.isFinite(parsed) && parsed > 0 ? parsed : 5;
  return tickMinute % interval === 0;
}

// ---------- Core loop ----------

async function runAll() {
  lastRunAt = new Date();
  const tickMinute = lastRunAt.getMinutes();

  let configs;
  try {
    configs = await CurveConfig.find({ sync_enabled: true }).lean();
  } catch (err) {
    console.error(`Scheduler: failed to load configs: ${err.message}`);
    return;
  }

  if (configs.length === 0) return;

  for (const config of configs) {
    if (!config.user_id) continue;
    if (!shouldRunAtTick(config, tickMinute)) continue;
    if (isSyncing(config._id)) continue;

    try {
      // OAuth configs have imap_password=null; decrypting null would
      // throw. Guard so both branches flow through the same code path.
      const plainConfig = {
        ...config,
        imap_password: config.imap_password
          ? decrypt(config.imap_password)
          : null,
      };
      const reader = await createImapReader(plainConfig);
      await syncEmails({ config: plainConfig, reader });
    } catch (err) {
      if (err instanceof SyncConflictError) continue;
      // Non-fatal: log and move on to the next config. Individual
      // email errors are already handled inside the orchestrator;
      // this catches connection-level failures (auth, network, etc.).
      console.error(
        `Scheduler: sync failed for config ${config._id}: ${err.message}`,
      );
    }
  }
}
