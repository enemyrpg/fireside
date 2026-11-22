#!/usr/bin/env bash
# Checks that argon2id works in a built Fireside image. Passwords are hashed
# with Node's own crypto.argon2 (OpenSSL 3.2+, built into the official Node
# binaries), so there is no native module to build, but the check proves it on
# each platform.
#
# Usage: scripts/docker/check-argon2.sh <image> [platform]
#   platform: e.g. linux/arm64 (runs under QEMU). Defaults to the image's own.
set -euo pipefail

image="${1:?Usage: $0 <image> [platform]}"
platform="${2:-}"

# A known-answer test: same input, same output on every platform.
script='
const { argon2Sync } = require("node:crypto");
const tag = argon2Sync("argon2id", {
  message: Buffer.from("password"),
  nonce: Buffer.from("somesalt"),
  parallelism: 1,
  tagLength: 32,
  memory: 19456,
  passes: 2,
}).toString("hex");
console.log(process.arch, process.versions.openssl, tag);
'

args=(run --rm --network none --entrypoint node)
if [ -n "$platform" ]; then args+=(--platform "$platform"); fi
output="$(docker "${args[@]}" "$image" -e "$script")"
echo "$output"

expected="$(node -e "$script" | awk '{print $3}')"
actual="$(echo "$output" | awk '{print $3}')"
if [ "$actual" != "$expected" ]; then
  echo "::error::argon2id in $image${platform:+ ($platform)} gave $actual, expected $expected"
  exit 1
fi
echo "argon2id in $image${platform:+ ($platform)}: OK"
