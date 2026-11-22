#!/usr/bin/env bash
# Checks the contents of a built Fireside image (see docs/legal.md and
# docs/decisions/0005-security-defaults.md):
#   - no image files in our own files (everything under /app except
#     node_modules) other than the favicon and the app icons, named one by one
#     in check-files.sh. The logo is inline SVG in the JS bundle
#     (web/src/branding/logo.ts); the icons are rendered from it;
#   - no .env file anywhere in the image;
#   - no database files (*.db, *.db-wal, …) anywhere, and nothing in a data/
#     folder (or data-dev/, data-seed/, …) under /app or in /data.
#
# The checks themselves are in check-files.sh, which reads the image's file
# list, so they can be tested without Docker.
#
# Usage: scripts/docker/check-image.sh <image>
set -euo pipefail

image="${1:?Usage: $0 <image>}"

container="$(docker create "$image")"
trap 'docker rm --force "$container" > /dev/null' EXIT

docker export "$container" | tar -t | "$(dirname "$0")/check-files.sh"
echo "Image $image: OK."
