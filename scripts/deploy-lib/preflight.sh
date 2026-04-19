#!/usr/bin/env bash
# preflight.sh — banner + sanity checks before any prod mutation.
# Sourced by deploy-prod.sh; never run standalone (relies on env vars).

do_preflight() {
  # ---- Local checks ----
  info "Local repo: $PROJECT_DIR"
  info "Target ref: $TARGET_REF"
  info "VPS:        $VPS_USER@$VPS_HOST:$VPS_PORT  →  $VPS_PATH"
  info "Process mgr: $PROCESS_MANAGER ($PM2_APP_NAME)"

  # 1. Local working tree must be clean — we want reproducible deploys.
  if [[ -n "$(git -C "$PROJECT_DIR" status --porcelain)" ]]; then
    fail "Local working tree is dirty. Commit or stash before deploying."
    git -C "$PROJECT_DIR" status --short
    exit 1
  fi
  success "Local tree clean"

  # 2. Resolve target SHA locally so we deploy a real commit.
  if ! TARGET_SHA=$(git -C "$PROJECT_DIR" rev-parse --verify "$TARGET_REF^{commit}" 2>/dev/null); then
    info "Fetching origin to resolve $TARGET_REF..."
    git -C "$PROJECT_DIR" fetch origin --quiet
    TARGET_SHA=$(git -C "$PROJECT_DIR" rev-parse --verify "$TARGET_REF^{commit}")
  fi
  export TARGET_SHA
  success "Target SHA: ${TARGET_SHA:0:12}  ($(git -C "$PROJECT_DIR" log -1 --format='%s' "$TARGET_SHA"))"

  # ---- Remote checks ----
  info "Probing $VPS_HOST..."
  local remote_state
  remote_state=$(ssh_run "
    set -e
    cd '$VPS_PATH' 2>/dev/null || { echo 'NO_PATH'; exit 0; }
    echo 'PWD='\$(pwd)
    echo 'CURRENT_SHA='\$(git rev-parse HEAD 2>/dev/null || echo 'none')
    echo 'CURRENT_REF='\$(git describe --always --all 2>/dev/null || echo 'none')
    echo 'NODE='\$(node -v 2>/dev/null || echo 'missing')
    echo 'NPM='\$(npm -v 2>/dev/null || echo 'missing')
    echo 'DISK='\$(df -h '$VPS_PATH' | tail -1 | awk '{print \$4\" free\"}')
    echo 'MEM='\$(free -m | awk '/Mem:/{printf \"%dMB free / %dMB\", \$7, \$2}')
    echo 'UPTIME='\$(uptime -p 2>/dev/null || uptime)
    if command -v pm2 >/dev/null 2>&1; then
      echo 'PM2='\$(pm2 jlist 2>/dev/null | grep -c '\"name\":\"$PM2_APP_NAME\"' || echo 0)
    else
      echo 'PM2=missing'
    fi
    echo 'MONGO='\$(systemctl is-active mongod 2>/dev/null || pgrep -x mongod >/dev/null && echo active || echo unknown)
  " 2>&1) || { fail "SSH probe failed"; echo "$remote_state"; exit 1; }

  if grep -q '^NO_PATH' <<<"$remote_state"; then
    fail "$VPS_PATH does not exist on the VPS"
    echo "  First-time setup: ssh in, then:"
    echo "    sudo mkdir -p $VPS_PATH && sudo chown $VPS_USER: $VPS_PATH"
    echo "    git clone <repo-url> $VPS_PATH"
    echo "    cp $VPS_PATH/server/.env.example $VPS_PATH/server/.env  # then edit"
    echo "    cd $VPS_PATH && npm run install:all && npm run build"
    echo "    pm2 start npm --name $PM2_APP_NAME --cwd $VPS_PATH -- run start"
    echo "    pm2 save"
    exit 1
  fi

  echo "$remote_state" | sed 's/^/    /'

  CURRENT_SHA=$(grep '^CURRENT_SHA=' <<<"$remote_state" | cut -d= -f2)
  PREVIOUS_REF="$CURRENT_SHA"   # exported by caller for rollback

  if [[ "$CURRENT_SHA" == "$TARGET_SHA" ]]; then
    warn "Server is already on $TARGET_SHA — nothing to deploy."
    if [[ "$ASSUME_YES" != true ]]; then
      read -r -p "Re-run anyway (rebuild + restart)? [y/N] " yn
      [[ "$yn" =~ ^[Yy]$ ]] || exit 0
    fi
  fi

  # ---- Commit diff since last deploy ----
  if [[ "$CURRENT_SHA" != "none" && -n "$CURRENT_SHA" ]]; then
    info "Commits to deploy ($CURRENT_SHA..$TARGET_SHA):"
    git -C "$PROJECT_DIR" log --oneline "$CURRENT_SHA..$TARGET_SHA" 2>/dev/null \
      | sed 's/^/    /' || warn "  (commits not in local history — git fetch?)"
  fi

  # ---- Pending migrations ----
  detect_pending_migrations
  if [[ -n "${PENDING_MIGRATIONS:-}" ]]; then
    warn "Migrations detected in this release:"
    for m in $PENDING_MIGRATIONS; do
      echo "    · $m"
    done
  fi

  # ---- Canonical deploy notes ----
  if [[ -f "$PROJECT_DIR/docs/DEPLOY_NOTES.md" ]]; then
    local banners
    banners=$(awk '/^## release:/{flag=1} flag' "$PROJECT_DIR/docs/DEPLOY_NOTES.md" 2>/dev/null | head -40)
    if [[ -n "$banners" ]]; then
      warn "Deploy banners (docs/DEPLOY_NOTES.md):"
      echo "$banners" | sed 's/^/    /'
    fi
  fi
}

# Populate $PENDING_MIGRATIONS by diffing the deploy range for migration scripts.
detect_pending_migrations() {
  PENDING_MIGRATIONS=""
  local current_sha
  current_sha=$(grep '^CURRENT_SHA=' <<<"$remote_state" | cut -d= -f2)
  if [[ -z "$current_sha" || "$current_sha" == "none" ]]; then
    # First deploy — run nothing automatically; operator will decide.
    return 0
  fi
  local files
  files=$(git -C "$PROJECT_DIR" diff --name-only "$current_sha..$TARGET_SHA" 2>/dev/null \
    | grep -E '^server/scripts/(migrate-|analyze-expense-dates\.js)' || true)
  PENDING_MIGRATIONS="$files"
  export PENDING_MIGRATIONS
}
