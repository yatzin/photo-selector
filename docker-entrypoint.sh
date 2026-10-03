#!/bin/sh
set -e

# Runs as the NAS user that owns the photo share (PUID/PGID), so files the app
# moves keep normal ownership and permissions. Find the IDs on the NAS with
# `id <username>` over SSH.
PUID="${PUID:-1000}"
PGID="${PGID:-100}"

# Only the app's own data folder is re-owned. The photo folders are never
# chown'd: they belong to the share, and PUID/PGID must already have access.
mkdir -p /data
chown -R "$PUID:$PGID" /data

export HOME=/tmp
gosu "$PUID:$PGID" npx prisma migrate deploy
gosu "$PUID:$PGID" npx tsx prisma/seed.ts

exec gosu "$PUID:$PGID" node server.js
