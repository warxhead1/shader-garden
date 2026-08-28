# deploy/ — provider-neutral TURN reference

This directory is a standalone reference for running a coturn instance
alongside the existing Shader Garden relay. It is NOT wired into the
repo's deploy.yml / GitHub Actions workflow and it does NOT mutate any
service configuration.

## What's here

| File | Purpose |
|---|---|
| `turnserver.conf.example` | The coturn config — read by the entrypoint at startup, placeholders filled in from env. |
| `turn-entrypoint.sh` | Renders the config under `/run/turnserver.conf` (mode 0600) and execs `coturn`. |
| `compose.turn.yml` | A `docker compose` reference using the official `coturn/coturn` image. |

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
EOF

# 4. Give the same SG_TURN_SHARED_SECRET to the relay container, plus
#    SG_TURN_URLS=turn:turn.example.org:3478?transport=udp,turns:turn.example.org:5349?transport=tcp
#    and SG_ALLOWED_ORIGINS=https://<your-pages-origin>.

# 5. Start coturn.
docker compose -f compose.turn.yml up -d
```

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
