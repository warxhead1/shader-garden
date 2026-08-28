#!/bin/sh
# turn-entrypoint.sh — render /etc/coturn/turnserver.conf into a 0600 file
# under /run, then drop the shared secret from the environment and exec
# coturn using the rendered config.
#
# Rationale: docker-compose will substitute environment variables into
# compose's own fields but NOT into bind-mounted config files. The cleanest
# portable approach is to render the config from a template at startup. We
# write to /run because it's tmpfs in most container runtimes, so the
# rendered file is gone the moment the container stops, and we set umask
# 077 + chmod 0600 so the secret never leaves the running container with
# world- or group-readable perms.
#
# PLACEHOLDER markers replaced:
#   PLACEHOLDER_STATIC_AUTH_SECRET  → $SG_TURN_SHARED_SECRET  (required)
#   PLACEHOLDER_REALM                → $SG_TURN_REALM          (default: turn.example.org)
#
# Substitution is done with awk (not bash's ${var//pat/rep}) so a secret
# containing `&`, `\`, or shell-special characters is replaced verbatim
# without surprises. awk is part of busybox (Alpine) and coreutils
# (Debian), so this works on every base image coturn ships.
#
# Exit codes:
#   1 — missing or empty SG_TURN_SHARED_SECRET
#   2 — missing or unreadable template
#   3 — template has placeholder(s) that no env var covers

set -eu

TEMPLATE="${TURN_TEMPLATE:-/etc/coturn/turnserver.conf}"
RENDERED="${TURN_RENDERED:-/run/turnserver.conf}"

# --- preconditions ----------------------------------------------------------

if [ -z "${SG_TURN_SHARED_SECRET:-}" ]; then
  echo "[turn-entrypoint] SG_TURN_SHARED_SECRET is required and must be non-empty" >&2
  exit 1
fi

if [ ! -r "$TEMPLATE" ]; then
  echo "[turn-entrypoint] template not readable: $TEMPLATE" >&2
  exit 2
fi

REALM="${SG_TURN_REALM:-turn.example.org}"

# --- render -----------------------------------------------------------------

umask 077
mkdir -p "$(dirname "$RENDERED")"

# awk pulls the values from its inherited environment via ENVIRON[] rather
# than via -v. This avoids shell quoting: a secret containing `&`, `\`,
# newlines, or single quotes is delivered to awk byte-for-byte, with no
# opportunity for the shell's quote-stripping to mangle it.
#
# The placeholder strings are literal; index()/substr() replace ALL
# occurrences on each line with no regex/glob interpretation.
awk '
  BEGIN {
    secret = ENVIRON["SG_TURN_SHARED_SECRET"]
    realm = (ENVIRON["SG_TURN_REALM"] == "") ? "turn.example.org" : ENVIRON["SG_TURN_REALM"]
    ph_s = "PLACEHOLDER_STATIC_AUTH_SECRET"
    ph_r = "PLACEHOLDER_REALM"
  }
  {
    line = $0
    # Replace placeholder_secret.
    out = ""
    rest = line
    while ((p = index(rest, ph_s)) > 0) {
      out = out substr(rest, 1, p - 1) secret
      rest = substr(rest, p + length(ph_s))
    }
    line = out rest
    # Replace placeholder_realm.
    out = ""
    rest = line
    while ((p = index(rest, ph_r)) > 0) {
      out = out substr(rest, 1, p - 1) realm
      rest = substr(rest, p + length(ph_r))
    }
    print out rest
  }
' "$TEMPLATE" > "$RENDERED"

chmod 0600 "$RENDERED"
# The coturn image's bundled non-root user is `turnserver`. chown may
# fail if the image was rebased; that's non-fatal — file perms (0600)
# are the actual security gate.
chown turnserver:turnserver "$RENDERED" 2>/dev/null || true

# --- verify rendering --------------------------------------------------------

# Strip coturn comments (whole-line `#` and end-of-line `#`) before
# checking for unresolved placeholders — the template's own commentary
# mentions PLACEHOLDER_* by name and must not trip the check.
if awk '
  {
    line = $0
    sub(/[ \t]*#.*$/, "", line)
    if (line ~ /PLACEHOLDER_(STATIC_AUTH_SECRET|REALM)/) { found = 1; exit 0 }
  }
  END { exit (found ? 0 : 1) }
' "$RENDERED"; then
  echo "[turn-entrypoint] rendered config still contains unresolved placeholders" >&2
  exit 3
fi

# --- drop secret and exec ---------------------------------------------------

# The coturn child does not need SG_TURN_SHARED_SECRET; dropping it from
# the process environment means a stray `cat /proc/$PID/environ` from
# inside the container can't reveal it.
unset SG_TURN_SHARED_SECRET

echo "[turn-entrypoint] rendered $RENDERED (0600), execing coturn" >&2

exec "$@" -c "$RENDERED"
