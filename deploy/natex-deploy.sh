#!/bin/bash
# NatEx auto-deploy (RUNBOOK §1). Run by natex-deploy.timer every 2 minutes as
# root; git, bun and the build run as the unprivileged `natex` user.
#
#   natex-deploy                 deploy origin/main if it moved (the timer)
#   natex-deploy --force         rebuild and restart even if nothing moved
#   natex-deploy --with-schema   also apply a schema change (backs up first)
#
# A commit that touches the Drizzle schema is HELD: the live database is never
# altered unattended. Take the decision, then run `natex-deploy --with-schema`.
# A release that fails its readiness check is rolled back to the last good commit.
# The demo site (natex-demo, port 4201) shares the checkout and restarts with it.
set -euo pipefail

APP=/opt/natex
STATE=/var/lib/natex
BUN=/home/natex/.bun/bin/bun
HEALTH=http://127.0.0.1:4200/api/health/ready
DEMO_ENV=/etc/natex/natex-demo.env
MODE="${1:-}"
mkdir -p "$STATE"

exec 9>"$STATE/deploy.lock"
flock -n 9 || exit 0

say() { echo "[natex-deploy] $*"; echo "$(date -Is) $*" >> "$STATE/deploy.log"; }
as_natex() { runuser -u natex -- "$@"; }

cd "$APP"
as_natex git fetch -q origin main
OLD=$(as_natex git rev-parse HEAD)
NEW=$(as_natex git rev-parse origin/main)

if [ "$OLD" = "$NEW" ] && [ -z "$MODE" ]; then exit 0; fi

if [ "$OLD" != "$NEW" ] && [ "$MODE" != "--with-schema" ]; then
  if ! as_natex git diff --quiet "$OLD" "$NEW" -- packages/web/src/api/database/schema packages/web/src/api/database/schema.ts; then
    if [ "$(cat "$STATE/held" 2>/dev/null)" != "$NEW" ]; then
      say "HELD ${NEW:0:7}: it changes the database schema. Back up, review, then run: natex-deploy --with-schema"
      echo "$NEW" > "$STATE/held"
    fi
    exit 0
  fi
fi

# Chained with && on purpose: `set -e` does not apply inside a function that
# is called as an `if` condition, so a failed install must stop the build here.
build() {
  as_natex git reset -q --hard "$1" &&
    install_deps &&
    as_natex env -C "$APP/packages/web" "$BUN" x vite build --logLevel error
}

# The registry occasionally drops a tarball; retry before giving up.
install_deps() {
  for attempt in 1 2 3; do
    as_natex env -C "$APP" "$BUN" install --frozen-lockfile --silent && return 0
    say "bun install failed (attempt $attempt)"
    sleep 5
  done
  return 1
}

healthy() {
  for _ in $(seq 1 30); do
    if [ "$(curl -s -o /dev/null -w '%{http_code}' "$HEALTH")" = "200" ]; then return 0; fi
    sleep 2
  done
  return 1
}

say "deploying ${NEW:0:7} (was ${OLD:0:7}) ${MODE}"
if ! build "$NEW"; then
  say "BUILD FAILED for ${NEW:0:7}; still serving ${OLD:0:7}"
  build "$OLD" || true
  exit 1
fi

if [ "$MODE" = "--with-schema" ]; then
  say "backing up before the schema push"
  as_natex bash -c "set -a; . /etc/natex/natex.env; set +a; cd $APP/packages/web && $BUN scripts/backup-drill.ts --discard" >> "$STATE/deploy.log" 2>&1 \
    || { say "BACKUP FAILED; schema not pushed, still serving ${OLD:0:7}"; build "$OLD" || true; exit 1; }
  as_natex bash -c "set -a; . /etc/natex/natex.env; set +a; cd $APP/packages/web && $BUN x drizzle-kit push --force" >> "$STATE/deploy.log" 2>&1 \
    || { say "SCHEMA PUSH FAILED; still serving ${OLD:0:7}"; build "$OLD" || true; exit 1; }
  # The demo site (RUNBOOK §1) runs the same checkout on its own dummy DB.
  if [ -f "$DEMO_ENV" ]; then
    as_natex bash -c "set -a; . $DEMO_ENV; set +a; cd $APP/packages/web && $BUN x drizzle-kit push --force" >> "$STATE/deploy.log" 2>&1 \
      || say "demo schema push failed (production unaffected)"
  fi
  rm -f "$STATE/held"
fi

restart_all() {
  systemctl restart natex
  # try-restart: only if the demo site is running; it never blocks a release.
  systemctl try-restart natex-demo || say "demo restart failed (production unaffected)"
}

restart_all
if healthy; then
  say "live: ${NEW:0:7}"
  echo "$NEW" > "$STATE/good"
  rm -f "$STATE/held"
  exit 0
fi

GOOD=$(cat "$STATE/good" 2>/dev/null || echo "$OLD")
say "READINESS FAILED for ${NEW:0:7}; rolling back to ${GOOD:0:7}"
build "$GOOD" && restart_all
healthy && say "rolled back: ${GOOD:0:7} live" || say "ROLLBACK ALSO UNHEALTHY — check: journalctl -u natex"
exit 1
