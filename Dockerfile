# Starfare testbed — dev-harness container (testbed slice 2, 03-08-26).
#
# Wraps the SAME sim/ the tests and invariants guard — no second engine. There
# is no build step and zero dependencies (Node's built-in http only), so the
# image is just the Node runtime plus the repo. In-memory + ephemeral by design:
# a restart returns to the zero-state (there is a POST /reset to start over
# without restarting). This is a DEV RIG, not the Phase-2 persistent server.
FROM node:22-alpine

WORKDIR /app

# Copy the repo in so the image is a self-contained, runnable artifact (it runs
# with no volume mount at all). At dev time you can still overlay live code with
# `-v "$(pwd)":/app`, so edits show up on the next restart without a rebuild.
COPY . .

# 7331 = the galaxy seed number, and clear of the host's other service ports.
# Override at run time with `-e PORT=...` and the matching `-p host:container`.
ENV PORT=7331
EXPOSE 7331

# The whole container: run the thin server, which holds the one live state in
# memory and exposes GET /snapshot, POST /tick, POST /action, POST /reset.
CMD ["node", "sim/server.js"]
