#!/bin/sh
# browser-orchestrator entrypoint.
# Sessions manage their own Xvfb displays (:N) through the orchestrator's slot
# pool. The optional fallback display (:0) is a container debugging aid only.
set -e

if [ "${FALLBACK_DISPLAY:-0}" = "1" ]; then
  echo "FALLBACK_DISPLAY=1: starting Xvfb :0 + openbox + x11vnc on 5900 (debug aid)"
  Xvfb :0 -screen 0 1280x800x24 -ac -nolisten tcp &
  sleep 1
  openbox &
  x11vnc -display :0 -localhost -rfbport 5900 -nopw -forever -shared &
fi

exec node /app/dist/index.js
