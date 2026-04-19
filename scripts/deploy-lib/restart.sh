#!/usr/bin/env bash
# restart.sh — restart the app + verify /api/health returns 2xx.
# Returns non-zero when the health check fails (caller triggers rollback).

do_restart() {
  case "$PROCESS_MANAGER" in
    pm2)
      info "pm2 restart $PM2_APP_NAME ..."
      ssh_run "
        set -euo pipefail
        cd '$VPS_PATH'
        if pm2 describe '$PM2_APP_NAME' >/dev/null 2>&1; then
          pm2 restart '$PM2_APP_NAME' --update-env
        else
          # First boot — register the process. Match the sleep-routine
          # convention: pm2 start npm -- run start.
          pm2 start npm --name '$PM2_APP_NAME' --cwd '$VPS_PATH' -- run start
          pm2 save
        fi
      " || { fail "pm2 restart failed"; return 1; }
      ;;
    systemd)
      info "systemctl restart $SYSTEMD_SERVICE ..."
      ssh_run "sudo systemctl restart '$SYSTEMD_SERVICE'" \
        || { fail "systemctl restart failed"; return 1; }
      ;;
    *)
      fail "Unknown PROCESS_MANAGER: $PROCESS_MANAGER"
      return 1 ;;
  esac
  success "App restarted"

  # Health check — poll up to 30s.
  info "Health check: http://127.0.0.1:$BACKEND_PORT$HEALTH_PATH ..."
  local code=""
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 3
    code=$(ssh_run "curl -s -o /dev/null -w '%{http_code}' --max-time 5 'http://127.0.0.1:$BACKEND_PORT$HEALTH_PATH' || echo 000" 2>/dev/null | tail -1)
    if [[ "$code" =~ ^2 ]]; then
      success "Health OK (HTTP $code) on attempt $attempt"
      return 0
    fi
    info "  attempt $attempt: HTTP $code — retrying..."
  done

  fail "Health check failed after 10 attempts (last HTTP $code)"
  # Dump recent logs to help diagnosis before rollback kicks in.
  if [[ "$PROCESS_MANAGER" == "pm2" ]]; then
    ssh_run "pm2 logs '$PM2_APP_NAME' --lines 30 --nostream 2>&1 | tail -40" || true
  else
    ssh_run "journalctl -u '$SYSTEMD_SERVICE' -n 30 --no-pager 2>&1 | tail -40" || true
  fi
  return 1
}
