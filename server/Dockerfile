# The Commons relay. One small stateless WebSocket process — no database, no
# disk, and (see ws.mjs) ZERO npm dependencies: Node ships no WebSocket server,
# so this repo implements the ~200 lines of RFC6455 the spec calls for rather
# than pulling in `ws`. That is why there is no install step here.
#
# Room state lives in memory and a room is gone when its last member leaves,
# so this scales by "run another one", and restarting it costs an in-progress
# round and nothing else.
FROM node:22-bookworm-slim

WORKDIR /app
COPY relay.mjs room.mjs ws.mjs ./

# Fly/Render/Railway all inject PORT. 8787 matches net.js's LOCAL_RELAY_PORT so
# a local `node relay.mjs` needs no flags at all.
ENV PORT=8787
EXPOSE 8787

# Reachable from the public internet by design — do not run it as root.
USER node

# SG_ALLOWED_ORIGINS locks WebSocket upgrades to your Pages origin. Unset is
# allowed (relay.mjs warns on every boot) but means anyone's page can open
# rooms on your relay. Set it to e.g. https://<owner>.github.io before going
# public; it accepts a comma-separated list.
CMD ["sh", "-c", "node relay.mjs --host 0.0.0.0 --port ${PORT} ${SG_ALLOWED_ORIGINS:+--origin $SG_ALLOWED_ORIGINS}"]
