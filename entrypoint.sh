#!/bin/sh
# Entrypoint for the merged Warden image (gateway + browser-orchestrator).
# One image, two roles:
#   ROLE unset / gateway (default) -> gateway             (node dist/index.js)
#   ROLE=browser                   -> browser-orchestrator (node /app/browser/dist/index.js)
# Selecting the role via ROLE is preferred; alternatively the container
# command selects it (running the orchestrator's command directly picks the
# browser role). Any other overridden command is exec'd verbatim.
# The browser role keeps the old browser image's entrypoint semantics,
# including the optional FALLBACK_DISPLAY debug display. Sessions manage their
# own Xvfb displays (:N) through the orchestrator's slot pool; the fallback
# display (:0) is a container debugging aid only.
set -e

GATEWAY_CMD="node dist/index.js"
BROWSER_CMD="node /app/browser/dist/index.js"

role="${ROLE:-gateway}"
override=0
if [ "$#" -gt 0 ]; then
  case "$*" in
    "$GATEWAY_CMD") ;;
    "$BROWSER_CMD") role=browser ;;
    *) override=1 ;;
  esac
fi

if [ "$role" = "browser" ]; then
  if [ "${FALLBACK_DISPLAY:-0}" = "1" ]; then
    echo "FALLBACK_DISPLAY=1: starting Xvfb :0 + openbox + x11vnc on 5900 (debug aid)"
    Xvfb :0 -screen 0 1280x800x24 -ac -nolisten tcp &
    sleep 1
    openbox &
    x11vnc -display :0 -localhost -rfbport 5900 -nopw -forever -shared &
  fi
  if [ "$override" = "0" ]; then
    exec node /app/browser/dist/index.js
  fi
fi

if [ "$override" = "0" ]; then
  exec node dist/index.js
fi

exec "$@"
