#!/usr/bin/env bash
# deploy/sg-watchdog.sh — external-path health watchdog for the multiplayer host.
#
# Compose already declares per-container healthchecks, but Docker does not ACT
# on an unhealthy container: `restart: unless-stopped` reacts to a process that
# EXITED, not to one that is up and wedged. This closes that gap, and probes the
# path a browser actually uses rather than the one the container can see:
#
#   relay — GET https://$SG_PUBLIC_HOST/healthz. Traverses Caddy, TLS and the
#           relay together, so it also catches a wedged proxy or an expired
#           certificate, neither of which the relay's own healthcheck can see.
#   turn  — a STUN Binding request to 3478/udp. coturn's compose healthcheck is
#           `pidof turnserver`, which proves a process exists and nothing more;
#           a coturn that is running but not answering looks perfectly healthy
#           to it. This asks for an actual reply.
#
# When the public path fails while the relay container itself reports healthy,
# the fault is in front of the relay, so Caddy gets restarted instead — a
# restart aimed at the wrong service is just downtime with extra steps.
#
# Failures must be CONSECUTIVE to trigger anything, and each service has a
# restart cooldown, so a flapping dependency cannot turn this into a restart
# loop. Everything goes to journald: `journalctl -t sg-watchdog`.
set -uo pipefail

COMPOSE_DIR=${SG_COMPOSE_DIR:-/opt/shaderland/deploy}
ENV_FILE=${SG_ENV_FILE:-$COMPOSE_DIR/host.env}
COMPOSE_FILE=${SG_COMPOSE_FILE:-$COMPOSE_DIR/compose.host.yml}
STATE_DIR=${SG_STATE_DIR:-/var/lib/sg-watchdog}
FAIL_THRESHOLD=${SG_FAIL_THRESHOLD:-3}
COOLDOWN=${SG_RESTART_COOLDOWN:-600}

log() { logger -t sg-watchdog -- "$*"; echo "sg-watchdog: $*"; }

# SG_PUBLIC_HOST only. Never source host.env: it also holds
# SG_TURN_SHARED_SECRET, and a sourced secret leaks into the environment of
# every command this script runs.
HOST=$(sed -n 's/^SG_PUBLIC_HOST=//p' "$ENV_FILE" 2>/dev/null | tr -d '"'\''' | head -1)
if [ -z "${HOST:-}" ]; then
  log "FATAL: SG_PUBLIC_HOST not found in $ENV_FILE"
  exit 78 # EX_CONFIG
fi

mkdir -p "$STATE_DIR"
dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

bump() { # $1=service -> new consecutive-failure count on stdout
  local f="$STATE_DIR/$1.fail" n
  n=$(( $(cat "$f" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"$f"
  echo "$n"
}
reset_fail() { echo 0 >"$STATE_DIR/$1.fail"; }

restart_svc() { # $1=service
  local svc=$1 last now f="$STATE_DIR/$1.last-restart"
  last=$(cat "$f" 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ $(( now - last )) -lt "$COOLDOWN" ]; then
    log "$svc still unhealthy but within ${COOLDOWN}s restart cooldown — not restarting"
    return
  fi
  log "restarting $svc after $FAIL_THRESHOLD consecutive failures"
  if dc restart "$svc" >/dev/null 2>&1; then
    log "$svc restarted"
  else
    log "ERROR: failed to restart $svc"
  fi
  echo "$now" >"$f"
  reset_fail "$svc"
}

# ---- relay / Caddy / TLS, over the public path ----------------------------
if curl -fsS --max-time 10 "https://$HOST/healthz" 2>/dev/null | grep -q '"ok":true'; then
  reset_fail relay
  reset_fail caddy
else
  # Ask the relay container what it thinks of itself, to aim the restart.
  cid=$(dc ps -q relay 2>/dev/null | head -1)
  health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
    "$cid" 2>/dev/null || echo unknown)
  if [ "$health" = healthy ]; then
    n=$(bump caddy)
    log "public /healthz FAILED ($n/$FAIL_THRESHOLD) but relay reports healthy — suspecting the proxy"
    [ "$n" -ge "$FAIL_THRESHOLD" ] && restart_svc caddy
  else
    n=$(bump relay)
    log "public /healthz FAILED ($n/$FAIL_THRESHOLD), relay health=$health"
    [ "$n" -ge "$FAIL_THRESHOLD" ] && restart_svc relay
  fi
fi

# ---- coturn, via a real STUN Binding request ------------------------------
if python3 - "$HOST" <<'PY' >/dev/null 2>&1
import random, socket, struct, sys
tid = bytes(random.randrange(256) for _ in range(12))
req = struct.pack('!HHI', 0x0001, 0, 0x2112A442) + tid          # STUN Binding request
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)
s.sendto(req, (sys.argv[1], 3478))
data, _ = s.recvfrom(1024)
# 0x0101 = Binding success response, and it must carry our transaction id.
sys.exit(0 if struct.unpack('!H', data[:2])[0] == 0x0101 and data[8:20] == tid else 1)
PY
then
  reset_fail turn
else
  n=$(bump turn)
  log "STUN Binding to $HOST:3478/udp FAILED ($n/$FAIL_THRESHOLD)"
  [ "$n" -ge "$FAIL_THRESHOLD" ] && restart_svc turn
fi

exit 0
