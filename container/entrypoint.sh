#!/bin/bash
set -e

if [ "$(id -u)" = "0" ]; then
  # Drop to host user (RUN_UID/RUN_GID passed by container-runner, defaults to node uid 1000)
  UID_TO_USE="${RUN_UID:-1000}"
  GID_TO_USE="${RUN_GID:-1000}"
  export HOME=/home/node
  exec /usr/bin/setpriv --reuid="$UID_TO_USE" --regid="$GID_TO_USE" --clear-groups /app/entrypoint.sh
fi

# Running as target user: compile and execute
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
