#!/usr/bin/env bash
# gate.sh — interactive confirm before any prod mutation.

do_gate() {
  if [[ "$ASSUME_YES" == true ]]; then
    info "--yes set — skipping confirmation"
    return 0
  fi

  echo ""
  echo -e "${YELLOW}About to deploy ${TARGET_SHA:0:12} to ${VPS_HOST}.${NC}"
  echo "  · process manager: $PROCESS_MANAGER ($PM2_APP_NAME)"
  echo "  · backend port:    $BACKEND_PORT"
  echo "  · backup:          $ENABLE_BACKUP (max $MAX_BACKUPS in $BACKUP_DIR)"
  echo ""
  read -r -p "Type 'deploy' to continue, anything else to abort: " reply
  if [[ "$reply" != "deploy" ]]; then
    fail "Aborted by user"
    exit 1
  fi
}
