# deploy/ — provider-neutral multiplayer host

This directory includes a single-host stack for the signaling relay, Caddy
TLS termination, and coturn, plus a standalone coturn reference. It is not
started by the GitHub Pages workflow; Pages only receives the resulting public
URLs through repository variables.

## What's here

| File | Purpose |
|---|---|
| `turnserver.conf.example` | The coturn config — read by the entrypoint at startup, placeholders filled in from env. |
| `turn-entrypoint.sh` | Renders the config under `/run/turnserver.conf` (mode 0600) and execs `coturn`. |
| `compose.turn.yml` | A `docker compose` reference using the official `coturn/coturn` image. |
| `compose.host.yml` | Relay + Caddy + coturn on one public host. |
| `Caddyfile` | Automatic HTTPS and WebSocket proxying for the relay. |
| `host.env.example` | Non-secret placeholders for the gitignored runtime env file. |
| `sg-watchdog.sh` + `.service` + `.timer` | Every-2-minute health probe over the PUBLIC path, with bounded self-healing. |
| `fail2ban-jail.local` | SSH jail config for the host (install to `/etc/fail2ban/jail.local`). |

## Single-host quick-start

```sh
cp deploy/host.env.example deploy/host.env
# Fill every value; generate the secret with: openssl rand -hex 32
docker compose --env-file deploy/host.env -f deploy/compose.host.yml config
docker compose --env-file deploy/host.env -f deploy/compose.host.yml up -d --build
docker compose --env-file deploy/host.env -f deploy/compose.host.yml ps
curl -fsS "https://$(sed -n 's/^SG_PUBLIC_HOST=//p' deploy/host.env)/healthz"
```

The relay is reachable only through Caddy. Coturn exposes 3478 over UDP/TCP
and the bounded 49152–49407 UDP relay range. The stack deliberately does not
advertise `turns:` until coturn certificate provisioning exists; WebRTC data
remains DTLS-encrypted when relayed over `turn:`.

## Operator quick-start

```sh
# 1. Copy this directory to your own deploy host (or to a separate repo
#    cloned alongside the relay). The relay and coturn can be anywhere;
#    the shared secret is the only thing that links them.
cp -r deploy /path/to/turn-deploy/

# 2. Generate the shared secret. THIS IS THE SECRET — store it where you
#    keep secrets (1Password, Vault, etc.), not in the repo.
openssl rand -hex 32

# 3. Set it as an env var for compose (and the same value for the relay).
cd /path/to/turn-deploy
cat > .env <<EOF
SG_TURN_SHARED_SECRET=<paste-the-secret>
SG_TURN_REALM=turn.example.org
SG_TURN_EXTERNAL_IP=<public-ipv4>
EOF

# 4. Give the same SG_TURN_SHARED_SECRET to the relay container, plus
#    SG_TURN_URLS=turn:turn.example.org:3478?transport=udp,turn:turn.example.org:3478?transport=tcp
#    and SG_ALLOWED_ORIGINS=https://<your-pages-origin>.

# 5. Start coturn.
docker compose -f compose.turn.yml up -d
```

## Keeping it up — the watchdog

Compose declares a healthcheck per container, but Docker never ACTS on one:
`restart: unless-stopped` reacts to a process that EXITED, not to one that is
up and wedged. And a container-internal check cannot see the things most
likely to break in production anyway — TLS, the proxy in front, or a coturn
that is running but no longer answering (its compose healthcheck is
`pidof turnserver`, which proves only that a process exists).

`sg-watchdog.sh` closes both gaps by probing the path a browser actually uses:

- `GET https://$SG_PUBLIC_HOST/healthz` — Caddy, TLS and the relay together.
- A real STUN Binding request to `3478/udp` — coturn actually replying.

Install it:

```sh
install -m 0755 deploy/sg-watchdog.sh /usr/local/bin/sg-watchdog.sh
install -m 0644 deploy/sg-watchdog.service deploy/sg-watchdog.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sg-watchdog.timer
journalctl -t sg-watchdog -f
```

Restarts are deliberately hard to trigger and hard to repeat: failures must be
CONSECUTIVE (3 by default) and each service has a 10-minute cooldown, so a
flapping dependency cannot become a restart loop. When the public probe fails
while the relay container still reports healthy, the watchdog restarts **Caddy**
rather than the relay — a restart aimed at the wrong service is just downtime
with extra steps. Tunables (`SG_FAIL_THRESHOLD`, `SG_RESTART_COOLDOWN`,
`SG_COMPOSE_DIR`) are environment overrides on the unit.

Verify it can actually fire — a watchdog that has never fired is
indistinguishable from a broken one:

```sh
docker compose --env-file deploy/host.env -f deploy/compose.host.yml stop turn
systemctl start sg-watchdog.service   # x3; the third restarts coturn
journalctl -t sg-watchdog -n 10
```

## Host hardening

`fail2ban-jail.local` → `/etc/fail2ban/jail.local`, then
`systemctl restart fail2ban`. SSH here should already be key-only, so this is
not what keeps an attacker out — it keeps the journal readable, so a real
incident is not buried under continuous credential-stuffing noise. It counts
authentication FAILURES, and a successful key auth is not one, so it cannot
lock out an operator holding the key. Note the `backend = systemd` line:
Ubuntu 24.04 logs sshd to the journal, and the default file backend would
happily watch a `/var/log/auth.log` that is never written and ban nobody.

## Why an entrypoint script?

Docker compose substitutes environment variables into the compose file's
own fields, but not into bind-mounted config files. The cleanest portable
way to keep the shared secret out of any on-disk config is to render the
config at container startup from a template:

1. `turn-entrypoint.sh` reads the template from `/etc/coturn/turnserver.conf`
   (mounted read-only from `turnserver.conf.example`).
2. It substitutes `PLACEHOLDER_STATIC_AUTH_SECRET` and `PLACEHOLDER_REALM`
   from `SG_TURN_SHARED_SECRET` and `SG_TURN_REALM` env vars.
3. It writes the rendered file to `/run/turnserver.conf` with `umask 077`
   + `chmod 0600` (so even if /run were world-readable, this file isn't).
4. It unsets `SG_TURN_SHARED_SECRET` from the process environment.
5. It `exec`s the original `turnserver` binary with `-c /run/turnserver.conf`.

The coturn process therefore never sees the secret as an env var, the
rendered file never leaves the container (it's on tmpfs), and the file
is gone when the container exits.

## Hardening notes baked in

- `use-auth-secret` + `static-auth-secret` — coturn's authenticated TURN REST
  scheme; coturn verifies the time-limited HMAC the relay issues. Do not add
  coturn's separate `no-auth` option.
- `fingerprint` — adds the RFC 5389 FINGERPRINT attribute.
- `min-port`/`max-port` (49152..49407) — the relay UDP range; bound the
  firewall to exactly this set.
- `denied-peer-ip` covers RFC1918 / loopback / link-local / multicast /
  TEST-NET / etc. so a relay client can't bounce traffic into your
  private network.
- `no-cli` — no telnet-style admin port. Coturn is configured only via
  the file.
- `cipher-list` — restricts TLS cipher suites; coturn 4.7 with its linked
  OpenSSL already excludes legacy TLS protocol versions.
- Compose runs as the official image's existing UID/GID 65534 from process
  start, drops all capabilities except the official binary's declared
  `NET_BIND_SERVICE` file capability, applies `no-new-privileges`, uses a
  read-only root filesystem, and puts its UID-owned `/run` on tmpfs.
- The relay itself is unchanged: it hands the browser a 600 s
  HMAC-SHA1(username, sharedSecret) credential, never the secret.

## What this reference does NOT do

- It does not provision a TLS certificate. `cert=` / `pkey=` in the
  config are commented out — fill them in (Caddy, certbot, etc.) before
  exposing TURNS (port 5349).
- It does not set up DNS. `SG_TURN_REALM` and the `turn:`/`turns:` URLs
  the relay publishes need to resolve to the host running this container.
- It does not scrape logs to a central sink. `docker logs` / the journald
  driver are the simplest paths; pipe `json-file` to `fluentd` or
  similar if you want aggregation.
- It does not back up anything. State is ephemeral by design.
