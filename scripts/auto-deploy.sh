#!/bin/sh
# Deploy the newest commit on the main branch, when CI passed on it.
# Cron starts this script every 2 minutes (see docs/deploy.md, section 7).
# When the stack runs the newest commit, the script stops at once. It sends
# no request to the GitHub API until a new commit is on main.
#
# The script reads DEPLOY_REPO (such as "owner/mortium") from .env. It
# writes one line to .deploy/deploy.log for each deploy and each failure,
# and the build output of the last deploy to .deploy/last-deploy.log.
set -eu

# Cron gives a short PATH. Docker from the snap package is in /snap/bin.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin
cd "$(dirname "$0")/.."
mkdir -p .deploy
exec >> .deploy/deploy.log 2>&1

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*"
}

# Do not start a second deploy while a deploy runs.
exec 9> .deploy/lock
flock -n 9 || exit 0

REPO=$(sed -n 's/^DEPLOY_REPO=//p' .env | tr -d '"')
if [ -z "$REPO" ]; then
  log "Set DEPLOY_REPO in .env."
  exit 1
fi
URL="https://github.com/$REPO.git"

REMOTE=$(git ls-remote "$URL" refs/heads/main | cut -f1)
if [ -z "$REMOTE" ]; then
  log "Cannot read the main branch of $URL."
  exit 1
fi
if [ "$REMOTE" = "$(git rev-parse HEAD)" ] || [ "$REMOTE" = "$(cat .deploy/skip 2> /dev/null)" ]; then
  exit 0
fi

# Find the CI run of this commit. Wait while it runs.
RUNS=$(curl -fsS "https://api.github.com/repos/$REPO/actions/workflows/ci.yml/runs?head_sha=$REMOTE&event=push&per_page=1")
STATUS=$(printf '%s' "$RUNS" | grep -o '"status": *"[a-z_]*"' | head -n 1 | cut -d '"' -f 4)
CONCLUSION=$(printf '%s' "$RUNS" | grep -o '"conclusion": *"[a-z_]*"' | head -n 1 | cut -d '"' -f 4)
if [ "$STATUS" != "completed" ]; then
  exit 0
fi

# A failed commit is not tried again. The next commit on main starts a new
# deploy. To try the same commit again, remove the file .deploy/skip.
if [ "$CONCLUSION" != "success" ]; then
  log "CI did not pass on $REMOTE ($CONCLUSION). The stack stays on $(git rev-parse --short HEAD)."
  echo "$REMOTE" > .deploy/skip
  exit 0
fi

log "Deploy $REMOTE."
if git fetch -q "$URL" main && git merge -q --ff-only FETCH_HEAD &&
  docker compose up -d --build > .deploy/last-deploy.log 2>&1; then
  docker image prune -f > /dev/null
  log "Deployed $REMOTE."
else
  log "The deploy of $REMOTE failed. See .deploy/last-deploy.log."
  echo "$REMOTE" > .deploy/skip
  exit 1
fi
