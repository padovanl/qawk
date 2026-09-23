#!/bin/bash
#
# The Qawk demo: the server, its console, sample data and simulated devices,
# all on docker -- nothing else needed.
#
#   demo/start.sh            build the images, start it all, load the sample
#                            data, start the simulated devices
#   demo/start.sh seed       load the sample data again (it is up already)
#   demo/start.sh down       stop and remove it all
#
# Then open the console: http://localhost:8090 (admin / the password below).
#
# Environment (all optional):
#   QAWK_ADMIN_PASSWORD   the administrator's password         (changeme)
#   QAWK_PORT             the server: device and management API (8080)
#   CONSOLE_PORT          the console                           (8090)
#   PROD_DEVICES          simulated devices in prod             (200)
#   SYSTEMS               simulated systems of device1, 2 device2 and a device3 (16)
#   USERS_FILE            a users file for the server (QAWK_USERS_FILE); without
#                         it the administrator is the only user
#
# Like a lab, not like production: PostgreSQL has no volume, so "down" and
# "up" again is an empty server.
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT=$(dirname "$HERE")
PASSWORD="${QAWK_ADMIN_PASSWORD:-changeme}"
QAWK_PORT="${QAWK_PORT:-8080}"
CONSOLE_PORT="${CONSOLE_PORT:-8090}"
PROD_DEVICES="${PROD_DEVICES:-200}"
SYSTEMS="${SYSTEMS:-16}"
USERS_FILE="${USERS_FILE:-}"

NET=qawk-demo
DB=qawk-demo-db
SERVER=qawk-demo-server
CONSOLE=qawk-demo-console
SIMS=qawk-demo-devices
SYSSIMS=qawk-demo-systems
TOKEN_FILE="$HERE/.gateway-token"

say() { printf '  %s\n' "$*"; }

down() {
    docker rm -f "$SIMS" "$SYSSIMS" "$CONSOLE" "$SERVER" "$DB" > /dev/null 2>&1 || true
    docker network rm "$NET" > /dev/null 2>&1 || true
}

seed() {
    python3 "$HERE/seed.py" --url "http://localhost:${QAWK_PORT}" --password "$PASSWORD" \
        --token "$(cat "$TOKEN_FILE")" "$@"
}

case "${1:-up}" in
  down) down; say "stopped"; exit 0 ;;
  seed) seed --stage all; exit 0 ;;
  up) ;;
  *) sed -n '5,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac

say "images: qawk:local from server/, qawk-console:local from console/"
docker build -q -t qawk:local "$ROOT/server" > /dev/null
docker build -q -t qawk-console:local "$ROOT/console" > /dev/null

down
[ -s "$TOKEN_FILE" ] || python3 -c 'import secrets; print("demo-" + secrets.token_hex(12))' > "$TOKEN_FILE"
docker network create "$NET" > /dev/null

say "PostgreSQL, the server on :${QAWK_PORT}, the console on :${CONSOLE_PORT}"
docker run -d --name "$DB" --network "$NET" \
  -e POSTGRES_USER=qawk -e POSTGRES_PASSWORD=qawk -e POSTGRES_DB=qawk \
  postgres:16-alpine > /dev/null
users=()
if [ -n "$USERS_FILE" ]; then
    [ -r "$USERS_FILE" ] || { echo "USERS_FILE: cannot read ${USERS_FILE}" >&2; exit 1; }
    users=(-v "$(realpath "$USERS_FILE"):/etc/qawk/users.yaml:ro" -e QAWK_USERS_FILE=/etc/qawk/users.yaml)
fi
docker run -d --name "$SERVER" --network "$NET" -p "${QAWK_PORT}:8080" \
  -e "QAWK_DATABASE_URL=postgres://qawk:qawk@${DB}:5432/qawk?sslmode=disable" \
  -e "QAWK_ADMIN_PASSWORD=${PASSWORD}" \
  "${users[@]}" qawk:local > /dev/null
docker run -d --name "$CONSOLE" --network "$NET" -p "${CONSOLE_PORT}:8090" \
  -e "HB_URL=http://${SERVER}:8080" \
  qawk-console:local > /dev/null

for _ in $(seq 1 90); do
    code=$(curl -s -o /dev/null -w '%{http_code}' -u "admin:${PASSWORD}" "http://localhost:${QAWK_PORT}/rest/v1/targets?limit=1" || true)
    [ "$code" = 200 ] && break
    sleep 2
done
[ "${code:-}" = 200 ] || { echo "the server did not answer: docker logs ${SERVER}" >&2; exit 1; }

say "sample data: catalogue, channels, the system type"
seed --stage base

say "simulated devices: dev, beta, prod (${PROD_DEVICES}), expo, and ${SYSTEMS} systems in four centres"
docker run -d --name "$SIMS" --network "$NET" --no-healthcheck --entrypoint qawk-sim qawk:local \
  -url "http://${SERVER}:8080" -token "$(cat "$TOKEN_FILE")" -prefix demo \
  -interval 30s -install-min 10s -install-max 60s \
  -fleet dev:20 -fleet beta:40:centers=1-2 -fleet "prod:${PROD_DEVICES}:centers=3-4" \
  -fleet expo:8 > /dev/null
docker run -d --name "$SYSSIMS" --network "$NET" --no-healthcheck --entrypoint qawk-sim qawk:local \
  -url "http://${SERVER}:8080" -token "$(cat "$TOKEN_FILE")" -prefix ctr \
  -interval 30s -install-min 5s -install-max 20s \
  -system "device:${SYSTEMS}:device1=1,device2=2,device3=1:centers=4" \
  -fail-where "device=device-07,device_type=device3,set=2.0" > /dev/null

say "centres in channels, and a first release in dev, once the devices have registered"
seed --stage devices

cat <<EOF

  Qawk is up.
    console        http://localhost:${CONSOLE_PORT}      admin / ${PASSWORD}
    server         http://localhost:${QAWK_PORT}
    gateway token  $(cat "$TOKEN_FILE")

  Stop it all:  demo/start.sh down
EOF
