#!/usr/bin/env bash
# pull-build.sh — fetch + checkout target ref, install deps, build client.
#
# Runs on the VPS (Ubuntu 16.04). Assumptions:
#   - $VPS_PATH is already a git checkout with origin pointing at this repo
#   - node + npm are on $PATH (no nvm assumed)
#   - npm ci works (lockfile is committed)
#   - server/.env already has prod values (we never touch it from here)

do_pull_build() {
  if [[ "$ENABLE_BACKUP" == "true" ]]; then
    backup_remote
  fi

  if [[ "$SKIP_BUILD" == true ]]; then
    warn "Skipping checkout + build (--skip-build) — only restart will run"
    return 0
  fi

  info "Fetching + checking out $TARGET_SHA on $VPS_HOST..."
  ssh_run "
    set -euo pipefail
    cd '$VPS_PATH'
    git fetch origin --tags --prune
    git checkout --detach '$TARGET_SHA'
    echo '[remote] HEAD now at:' \$(git rev-parse --short HEAD)
  " || { fail "git checkout failed"; exit 1; }
  success "Checked out $TARGET_SHA"

  info "Installing dependencies (npm ci) — root + client + server..."
  # npm ci --omit=dev was added in npm 7. Check first; on really old npm,
  # fall back to --production. Server deps must be installed without dev (we
  # don't need vitest/etc on prod), client needs devDeps for the build.
  ssh_run "
    set -euo pipefail
    cd '$VPS_PATH'
    NPM_MAJOR=\$(npm -v | cut -d. -f1)

    echo '[remote] root deps...'
    if [ \"\$NPM_MAJOR\" -ge 7 ]; then
      npm ci --omit=dev --no-audit --no-fund
    else
      npm ci --production --no-audit
    fi

    echo '[remote] server deps...'
    cd server
    if [ \"\$NPM_MAJOR\" -ge 7 ]; then
      npm ci --omit=dev --no-audit --no-fund
    else
      npm ci --production --no-audit
    fi
    cd ..

    echo '[remote] client deps (incl. dev for build)...'
    cd client
    npm ci --no-audit --no-fund
    cd ..
  " || { fail "npm ci failed"; exit 1; }
  success "Dependencies installed"

  info "Building client (vite)..."
  ssh_run "
    set -euo pipefail
    cd '$VPS_PATH'
    NODE_ENV=production npm run build
    test -f client/dist/index.html
    echo '[remote] build OK — client/dist/index.html present'
  " || { fail "Build failed"; exit 1; }
  success "Client built — client/dist/ refreshed"
}

backup_remote() {
  info "Snapshotting current deploy → $BACKUP_DIR ..."
  ssh_run "
    set -euo pipefail
    sudo mkdir -p '$BACKUP_DIR'
    sudo chown $VPS_USER: '$BACKUP_DIR'
    cd '$VPS_PATH'
    CURRENT=\$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')
    STAMP=\$(date +%Y%m%d-%H%M%S)
    NAME=\"\${STAMP}-\${CURRENT}.tar.gz\"
    # Exclude node_modules + build output — they'll be rebuilt.
    tar --exclude=node_modules --exclude=client/dist --exclude=.git \\
        -czf \"$BACKUP_DIR/\$NAME\" -C '$(dirname "$VPS_PATH")' '$(basename "$VPS_PATH")' 2>/dev/null
    echo \"[remote] backup: \$NAME (\$(du -h \"$BACKUP_DIR/\$NAME\" | cut -f1))\"

    # Trim
    cd '$BACKUP_DIR'
    ls -1t *.tar.gz 2>/dev/null | tail -n +\$(( $MAX_BACKUPS + 1 )) | xargs -r rm -f
  " || warn "Backup step failed (continuing)"
  success "Backup taken"
}
