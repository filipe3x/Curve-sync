import cron from 'node-cron';
import CurveConfig from '../models/CurveConfig.js';
import { syncEmails, isSyncing, SyncConflictError } from './syncOrchestrator.js';
import { ImapReader } from './imapReader.js';

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

// ---------- Core loop ----------

async function runAll() {
  lastRunAt = new Date();

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
    if (isSyncing(config._id)) continue;

    try {
      const reader = new ImapReader(config);
      await syncEmails({ config, reader });
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
