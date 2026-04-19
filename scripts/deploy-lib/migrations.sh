#!/usr/bin/env bash
# migrations.sh — runs server/scripts/migrate-* (and the canonical
# date_at backfill `analyze-expense-dates.js`) detected during preflight.
#
# Migrations are executed BEFORE pm2 restart so the new code never reads
# rows that the migration is supposed to populate. If a migration script
# requires a special flag, the convention is: call it with `--write --yes`
# (the standard "execute, no prompt" idiom used in this repo).

do_migrations() {
  if [[ -z "${PENDING_MIGRATIONS:-}" ]]; then
    info "No pending migrations in $PREVIOUS_REF..$TARGET_SHA"
    return 0
  fi

  warn "Pending migrations:"
  for m in $PENDING_MIGRATIONS; do
    echo "    · $m"
  done

  if [[ "$ASSUME_YES" != true ]]; then
    echo ""
    read -r -p "Run them now? [y/N] " yn
    [[ "$yn" =~ ^[Yy]$ ]] || { fail "Migrations declined — aborting deploy"; exit 1; }
  fi

  for migration in $PENDING_MIGRATIONS; do
    info "Running $migration..."
    # The orchestrator stops the running app first to avoid concurrent
    # writes during destructive migrations.
    stop_remote_app
    ssh_run "
      set -euo pipefail
      cd '$VPS_PATH'
      node '$migration' --write --yes
    " || { fail "Migration failed: $migration"; exit 1; }
    success "Migration done: $migration"
  done
}

stop_remote_app() {
  case "$PROCESS_MANAGER" in
    pm2)
      ssh_run "pm2 stop '$PM2_APP_NAME' || true" >/dev/null ;;
    systemd)
      ssh_run "sudo systemctl stop '$SYSTEMD_SERVICE' || true" >/dev/null ;;
  esac
}
