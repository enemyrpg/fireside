#!/usr/bin/env bash
# Checks that the native modules in a built Fireside image load and work on
# its platform: better-sqlite3 opens an in-memory database, writes and reads a
# row. Its prebuilt binary is chosen per platform when the image is built (the
# `deps` stage in the Dockerfile), so a wrong or missing binary for arm64 only
# shows up when it runs there.
#
# Usage: scripts/docker/check-native.sh <image> [platform]
#   platform: e.g. linux/arm64 (runs under QEMU). Defaults to the image's own.
set -euo pipefail

image="${1:?Usage: $0 <image> [platform]}"
platform="${2:-}"

# Resolved from the server package, as the server itself does.
script='
const { createRequire } = require("node:module");
const Database = createRequire("/app/server/package.json")("better-sqlite3");
const db = new Database(":memory:");
db.exec("CREATE TABLE t (v TEXT)");
db.prepare("INSERT INTO t (v) VALUES (?)").run("ok");
const row = db.prepare("SELECT v, sqlite_version() AS version FROM t").get();
if (row.v !== "ok") throw new Error("unexpected row");
console.log(process.arch, "sqlite", row.version);
'

args=(run --rm --network none --entrypoint node)
if [ -n "$platform" ]; then args+=(--platform "$platform"); fi
out="$(docker "${args[@]}" "$image" -e "$script")"
echo "$out"
# Node's name for the platform's CPU: linux/amd64 is x64.
if [ -n "$platform" ]; then
  arch="${platform#linux/}"
  [ "$arch" = amd64 ] && arch=x64
  if [ "${out%% *}" != "$arch" ]; then
    echo "::error::Expected $arch ($platform), got: $out"
    exit 1
  fi
fi
echo "Native modules in $image${platform:+ ($platform)}: OK."
