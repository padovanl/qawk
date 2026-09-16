#!/bin/bash
#
# Simulated devices for any Qawk server -- the demo's or your own. Each run is
# a container of qawk-sim (in the server image): devices that register, poll,
# take the updates they are given and report how they went. Anything whose
# module name contains "broken" fails.
#
#   demo/simulate.sh --url http://host:8080 --token T --fleet dev:20 --fleet prod:500
#   demo/simulate.sh --url http://host:8080 --token T --systems 16
#   demo/simulate.sh --name lab --url ... --token T --fleet beta:100 -- -fail-rate 0.05
#   demo/simulate.sh --list              what is running
#   demo/simulate.sh --stop [name]       stop one, or all of them
#
# Options:
#   --url URL          the server (http://localhost:8080)
#   --token T          the gateway token (the demo's, demo/.gateway-token, if left out)
#   --fleet NAME:N     N devices reporting ring=NAME, which a fleet's rule can
#                      pick up (attribute.ring==NAME); repeatable
#   --systems N        N systems, each a device1 with two device2 and a device3,
#                      shared out among four centres (c01..c04)
#   --name NAME        tells runs apart: container qawk-sim-NAME, device ids
#                      NAME-<fleet>-<n> (sim)
#   --interval D       how often each device polls (30s)
#   --image IMAGE      the server image ($QAWK_IMAGE, else qawk:local, else padovanl/qawk:0.1.0)
#   --network NET      a docker network to join, e.g. the demo's qawk-demo (host)
#   -- ...             anything after it goes to qawk-sim as it is: -fail-rate,
#                      -install-min, -install-max, -fail-where (qawk-sim -help)
set -euo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
URL=http://localhost:8080
TOKEN=""
NAME=sim
INTERVAL=30s
NETWORK=host
IMAGE="${QAWK_IMAGE:-}"
ARGS=()

usage() { sed -n '3,28p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --url)      URL="$2"; shift 2 ;;
        --token)    TOKEN="$2"; shift 2 ;;
        --fleet)    ARGS+=(-fleet "$2"); shift 2 ;;
        --systems)  ARGS+=(-system "device:$2:device1=1,device2=2,device3=1:centers=4"); shift 2 ;;
        --name)     NAME="$2"; shift 2 ;;
        --interval) INTERVAL="$2"; shift 2 ;;
        --image)    IMAGE="$2"; shift 2 ;;
        --network)  NETWORK="$2"; shift 2 ;;
        --list)
            docker ps --filter label=qawk.sim --format '{{.Names}}\t{{.Status}}\t{{.Command}}'
            exit 0 ;;
        --stop)
            if [ -n "${2:-}" ]; then docker rm -f "qawk-sim-$2" > /dev/null
            else ids=$(docker ps -aq --filter label=qawk.sim); [ -z "$ids" ] || docker rm -f $ids > /dev/null; fi
            echo "stopped"; exit 0 ;;
        -h|--help)  usage ;;
        --)         shift; ARGS+=("$@"); break ;;
        *)          echo "unknown option: $1" >&2; usage 1 ;;
    esac
done

printf '%s\n' "${ARGS[@]}" | grep -qx -- '-fleet\|-system' \
    || { echo "nothing to simulate: give --fleet NAME:N or --systems N" >&2; exit 1; }
if [ -z "$TOKEN" ] && [ -s "$HERE/.gateway-token" ]; then TOKEN=$(cat "$HERE/.gateway-token"); fi
if [ -z "$IMAGE" ]; then
    if docker image inspect qawk:local > /dev/null 2>&1; then IMAGE=qawk:local; else IMAGE=padovanl/qawk:0.1.0; fi
fi

docker rm -f "qawk-sim-${NAME}" > /dev/null 2>&1 || true
docker run -d --name "qawk-sim-${NAME}" --label qawk.sim=1 --network "$NETWORK" \
    --restart unless-stopped --no-healthcheck --entrypoint qawk-sim "$IMAGE" \
    -url "$URL" -token "$TOKEN" -prefix "$NAME" -interval "$INTERVAL" "${ARGS[@]}" > /dev/null
echo "qawk-sim-${NAME} is running against ${URL}"
echo "  logs: docker logs -f qawk-sim-${NAME}    stop: demo/simulate.sh --stop ${NAME}"
