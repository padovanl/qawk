#!/bin/bash
#
# QubicaAMF - run the hawkBit console in a container.
#
#   ./ota/hawkbit-ui/run-console.sh up      build if needed, then start
#   ./ota/hawkbit-ui/run-console.sh down    stop and remove
#   ./ota/hawkbit-ui/run-console.sh logs    follow the proxy log
#   ./ota/hawkbit-ui/run-console.sh rebuild rebuild the image and restart
#
# start-hawkbit.sh starts this by itself, so you rarely need this script. It is
# here for restarting the console alone -- after editing app.js, say -- without
# touching the server, whose database is in memory and would be wiped.
#
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)

IMG=qamf-hawkbit-console:local
NAME=qamf-hawkbit-console
NET=qamf-hb-net
PORT="${HAWKBIT_CONSOLE_PORT:-8090}"
# Inside the network the server answers to its alias; from outside, pass
# --hawkbit or set HB_URL.
HB="${HB_URL:-http://hawkbit:8080}"

cmd="${1:-up}"

case "$cmd" in
  down)
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    echo "console stopped."
    ;;
  logs)
    docker logs -f "$NAME"
    ;;
  rebuild|up)
    [ "$cmd" = "rebuild" ] && docker rmi -f "$IMG" > /dev/null 2>&1 || true
    if ! docker image inspect "$IMG" > /dev/null 2>&1; then
      echo "building ${IMG}..."
      docker build -q -t "$IMG" "$HERE" > /dev/null
    fi
    docker rm -f "$NAME" > /dev/null 2>&1 || true
    docker network create "$NET" > /dev/null 2>&1 || true
    docker run -d --name "$NAME" --network "$NET" \
      -p "${PORT}:8090" -e "HB_URL=${HB}" "$IMG" > /dev/null

    ip=$(ip -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -1)
    echo "console : http://${ip:-localhost}:${PORT}"
    echo "hawkBit : ${HB}"
    ;;
  *)
    sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac
