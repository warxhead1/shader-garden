# The Commons relay. One small stateless WebSocket process — no database, no
# disk, and (see ws.mjs) ZERO npm dependencies: Node ships no WebSocket server,
# so this repo implements the ~200 lines of RFC6455 the spec calls for rather
# than pulling in `ws`. That is why there is no install step here.
#
# Room state lives in memory and a room is gone when its last member leaves,
# so this scales by "run another one", and restarting it costs an in-progress
# round and nothing else.
#
# Build context is the repo ROOT (not server/), so the relay and the shared
# browser-safe reducer can be copied together. The reducer lives at
# site/js/multiplayer/room-core.js (Wave-5 §1 frozen contract) and is the
# same file the elected browser host loads; server/room.mjs is a thin
# re-export of it. Both paths must be present at runtime so the
# `from '../site/js/multiplayer/room-core.js'` import resolves.
FROM node:22-bookworm-slim

WORKDIR /app

# Relay + codec go under server/ (matching the CMD's path); the shared
# reducer lives under site/js/multiplayer/ at its source-tree location
# so server/room.mjs's relative import resolves unchanged.
COPY relay.mjs signal.mjs room.mjs ws.mjs ./server/
COPY site/js/multiplayer/room-core.js ./site/js/multiplayer/room-core.js

# Fly/Render/Railway all inject PORT. 8787 matches net.js's LOCAL_RELAY_PORT so
# a local `node server/relay.mjs` needs no flags at all.
ENV PORT=8787
EXPOSE 8787

# Reachable from the public internet by design — do not run it as root.
USER node

# SG_ALLOWED_ORIGINS locks WebSocket upgrades to your Pages origin. Unset is
# allowed (relay.mjs warns on every boot) but means anyone's page can open
# rooms on your relay. Set it to e.g. https://<owner>.github.io before going
# public; it accepts a comma-separated list.
CMD ["sh", "-c", "node server/relay.mjs --host 0.0.0.0 --port ${PORT} ${SG_ALLOWED_ORIGINS:+--origin $SG_ALLOWED_ORIGINS}"]
