#!/usr/bin/env bash
# rollback.sh — emergency revert to the previous SHA + restart.
# Two entry points:
#   do_rollback "$PREVIOUS_REF"  — invoked automatically when health check fails
#   do_rollback_only             — invoked via `deploy-prod.sh --rollback`,
#                                   reads the previous SHA from the most recent
#                                   backup tarball name (timestamp-<sha>.tar.gz).

do_rollback() {
  local target="${1:-}"
  if [[ -z "$target" || "$target" == "none" ]]; then
    fail "No previous SHA known — cannot auto-rollback"
    fail "Manual recovery: ssh in, restore from $BACKUP_DIR, pm2 restart $PM2_APP_NAME"
    return 1
  fi

  warn "Rolling back to $target"
  ssh_run "
    set -euo pipefail
    cd '$VPS_PATH'
    git checkout --detach '$target'
    NPM_MAJOR=\$(npm -v | cut -d. -f1)
    if [ \"\$NPM_MAJOR\" -ge 7 ]; then
      npm ci --omit=dev --no-audit --no-fund
      cd server && npm ci --omit=dev --no-audit --no-fund && cd ..
    else
      npm ci --production --no-audit
      cd server && npm ci --production --no-audit && cd ..
    fi
    cd client && npm ci --no-audit --no-fund && cd ..
    NODE_ENV=production npm run build
  " || { fail "Rollback rebuild failed — manual intervention required"; return 1; }

  case "$PROCESS_MANAGER" in
    pm2)     ssh_run "pm2 restart '$PM2_APP_NAME' --update-env" ;;
    systemd) ssh_run "sudo systemctl restart '$SYSTEMD_SERVICE'" ;;
  esac

  warn "Rollback complete · server is back on $target"
  warn "Investigate logs and re-run when fixed."
}

# Manual rollback path: figure out the previous SHA from backup filenames.
do_rollback_only() {
  info "Looking up previous SHA from $BACKUP_DIR ..."
  local prev
  prev=$(ssh_run "
    cd '$BACKUP_DIR' 2>/dev/null || { echo ''; exit 0; }
    # Backups are named: YYYYMMDD-HHMMSS-<shortsha>.tar.gz
    # Pick the second-most-recent (the most recent is the snapshot taken
    # right before the current — broken — release).
    ls -1t *.tar.gz 2>/dev/null | sed -n '2p' | sed -E 's/.*-([0-9a-f]+)\.tar\.gz/\1/'
  ")
  if [[ -z "$prev" ]]; then
    fail "No previous backup found in $BACKUP_DIR"
    exit 1
  fi
  info "Previous SHA: $prev"
  if [[ "$ASSUME_YES" != true ]]; then
    read -r -p "Rollback to $prev now? [y/N] " yn
    [[ "$yn" =~ ^[Yy]$ ]] || { fail "Aborted"; exit 1; }
  fi
  do_rollback "$prev"
}
