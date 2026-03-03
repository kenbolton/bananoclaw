#!/bin/bash
set -e

# Shadow .env to prevent agents from reading host secrets.
# The project root is mounted read-only, but .env contains API keys.
# Apple Container (VirtioFS) only supports directory mounts, not file mounts,
# so we shadow .env via mount --bind inside the VM (requires root at start).
if [ "$(id -u)" = "0" ]; then
  if [ -f /workspace/project/.env ]; then
    mount --bind /dev/null /workspace/project/.env 2>/dev/null || true
  fi
  # Drop to host user (RUN_UID/RUN_GID passed by container-runner, defaults to node uid 1000)
  UID_TO_USE="${RUN_UID:-1000}"
  GID_TO_USE="${RUN_GID:-1000}"
  export HOME=/home/node
  exec /usr/bin/setpriv --reuid="$UID_TO_USE" --regid="$GID_TO_USE" --init-groups /app/entrypoint.sh
fi

# Running as target user: compile and execute
cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2
ln -s /app/node_modules /tmp/dist/node_modules
chmod -R a-w /tmp/dist
cat > /tmp/input.json
node /tmp/dist/index.js < /tmp/input.json
