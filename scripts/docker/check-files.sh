#!/usr/bin/env bash
# Checks a list of the files in a Fireside image, one path per line on stdin
# (as `tar -t` prints them, without a leading ./). Used by check-image.sh, and
# tested on its own (scripts/docker/check-files.test.ts). See check-image.sh
# for what is checked and why.
#
# Usage: <listing> | scripts/docker/check-files.sh
set -euo pipefail

# The only image files allowed in our own files, by exact path: the favicon
# and the app icons (rendered from web/src/branding/logo.ts). Never a pattern:
# any other image, also under these folders, fails.
allowed_images=(
  app/web/dist/favicon.svg
  app/web/dist/apple-touch-icon.png
  app/web/dist/icons/icon-192.png
  app/web/dist/icons/icon-512.png
  app/web/dist/icons/icon-maskable-512.png
)

if [ "${1:-}" = "--allowed-images" ]; then
  printf '%s\n' "${allowed_images[@]}"
  exit 0
fi

files="$(sed 's|^\./||')"

failed=0
report() {
  local title="$1" matches="$2"
  if [ -n "$matches" ]; then
    echo "::error::$title:"
    echo "$matches" | sed 's/^/  /'
    failed=1
  fi
}

own_images="$(
  echo "$files" \
    | grep -E '^app/' \
    | grep -vE '(^|/)node_modules/' \
    | grep -iE '\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|apng|jxl|heic)$' \
    | grep -vxF -f <(printf '%s\n' "${allowed_images[@]}") \
    || true
)"
report "Image files in /app (only ${allowed_images[*]} are allowed)" "$own_images"

env_files="$(echo "$files" | grep -E '(^|/)\.env(\..+)?$' || true)"
report ".env files in the image" "$env_files"

db_files="$(echo "$files" | grep -iE '\.(db|sqlite3?)(-(wal|shm|journal))?$' || true)"
report "Database files in the image" "$db_files"

data_files="$(echo "$files" | grep -E '^(app/(.+/)?data(-[^/]+)?/.|data/.)' | grep -vE '(^|/)node_modules/' || true)"
report "Files in a data folder" "$data_files"

if [ "$failed" -ne 0 ]; then exit 1; fi
echo "OK ($(echo "$files" | wc -l) entries checked)."
