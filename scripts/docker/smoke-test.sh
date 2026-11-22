#!/usr/bin/env bash
# Starts the image with docker-compose.yml (host networking) on a spare port
# and a temporary data folder, then checks that:
#   - the container becomes healthy and listens on 127.0.0.1 only;
#   - health, a dashboard endpoint and the app answer 200 over loopback, so
#     the localhost-only dashboard check works through Docker;
#   - the CLI works inside the container;
#   - a backup is taken at startup into the data folder, `backup` works through
#     `exec`, `restore` refuses while the server runs and works in a one-off
#     container with the server stopped;
#   - the bind-mounted data folder is private to FIRESIDE_UID (folders 700,
#     files 600), also a folder that was 755 before,
#     and the server and the CLI still read and write it.
#
# Usage: scripts/docker/smoke-test.sh   (expects the image fireside:local, or
#        FIRESIDE_LOCAL_IMAGE; uses docker-compose.build.yml, never pulls)
set -euo pipefail

cd "$(dirname "$0")/../.."
export FIRESIDE_PORT="${FIRESIDE_PORT:-3199}"
FIRESIDE_DATA_PATH="$(mktemp -d)"
export FIRESIDE_DATA_PATH
export FIRESIDE_UID="$(id -u)" FIRESIDE_GID="$(id -g)"
project=fireside-smoke
# The built image, not the release from GHCR. The files are named here, so a
# COMPOSE_FILE from the environment can't change them.
compose() {
  docker compose --project-name "$project" \
    --file docker-compose.yml --file docker-compose.build.yml "$@"
}

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then compose logs --no-color --tail 50 || true; fi
  compose down --volumes > /dev/null 2>&1 || true
  rm -rf "$FIRESIDE_DATA_PATH"
}
trap cleanup EXIT

wait_healthy() {
  local status=starting container
  for _ in $(seq 1 30); do
    # Empty while the container is (re)starting, e.g. in a crash loop.
    container="$(compose ps --all --quiet fireside)"
    if [ -n "$container" ]; then
      status="$(docker inspect --format '{{.State.Health.Status}}' "$container" 2> /dev/null || echo missing)"
    else
      status=missing
    fi
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  echo "::error::Container is $status, not healthy"
  exit 1
}

# As a data folder from before the server made it private: open to everyone.
chmod 755 "$FIRESIDE_DATA_PATH"

# Folders are 700 and files 600, for the user the container runs as.
expect_mode() {
  local path="$1" want="$2" got
  got="$(stat --format '%a' "$path")"
  if [ "$got" != "$want" ]; then
    echo "::error::${path#"$FIRESIDE_DATA_PATH"/} has mode $got, expected $want"
    exit 1
  fi
}
expect_private() {
  local path
  expect_mode "$FIRESIDE_DATA_PATH" 700
  expect_mode "$FIRESIDE_DATA_PATH/backups" 700
  while IFS= read -r path; do
    expect_mode "$path" 600
  done < <(find "$FIRESIDE_DATA_PATH" -type f)
  if [ "$(stat --format '%u' "$FIRESIDE_DATA_PATH/fireside.db")" != "$FIRESIDE_UID" ]; then
    echo "::error::fireside.db is not owned by FIRESIDE_UID"
    exit 1
  fi
}

compose up --detach --no-build
wait_healthy

listeners="$(ss -Htln "sport = :$FIRESIDE_PORT" | awk '{print $4}')"
if [ "$listeners" != "127.0.0.1:$FIRESIDE_PORT" ]; then
  echo "::error::Expected to listen on 127.0.0.1:$FIRESIDE_PORT only, got: $listeners"
  exit 1
fi

for path in /api/v1/health /api/v1/keys /api/v1/admin/backups /; do
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:$FIRESIDE_PORT$path")"
  if [ "$code" != 200 ]; then
    echo "::error::GET $path answered $code, expected 200"
    exit 1
  fi
done

# Backups: one at startup (new database), in the bind-mounted folder.
backups="$FIRESIDE_DATA_PATH/backups"
newest_backup() {
  find "$backups" -maxdepth 1 -name 'fireside-*Z*.db' -printf '%f\n' 2> /dev/null | sort | tail -n 1
}
if [ -z "$(newest_backup)" ]; then
  echo "::error::No startup backup in FIRESIDE_DATA_PATH/backups"
  exit 1
fi
# The database, its -wal and -shm, the lock and the startup backup.
expect_private
for file in fireside.db fireside.db-wal fireside.lock; do
  if [ ! -f "$FIRESIDE_DATA_PATH/$file" ]; then
    echo "::error::No $file in FIRESIDE_DATA_PATH"
    exit 1
  fi
done
if ! compose logs --no-color fireside | grep 'File permissions: made [0-9]* path' >/dev/null; then
  echo "::error::The server did not log that it made the data folder private"
  exit 1
fi
out="$(compose exec -T fireside fireside backup)"
grep -q 'Backup saved' <<< "$out"
out="$(curl --silent "http://127.0.0.1:$FIRESIDE_PORT/api/v1/admin/backups")"
grep -q '"count":' <<< "$out"
backup="$(newest_backup)"
# The backup the CLI took through `exec`.
expect_private

# A key created after the backup.
compose exec -T fireside fireside keys create smoke-test > /dev/null
out="$(compose exec -T fireside fireside keys list)"
grep -q smoke-test <<< "$out"

# The database must be in the bind-mounted folder, not inside the container.
if [ ! -f "$FIRESIDE_DATA_PATH/fireside.db" ]; then
  echo "::error::No fireside.db in FIRESIDE_DATA_PATH: the data folder is not mounted at DATA_DIR"
  exit 1
fi

# Restore refuses while the server runs, and works with it stopped.
if compose exec -T fireside fireside restore "$backup" > /dev/null 2>&1; then
  echo "::error::restore ran while the server was running"
  exit 1
fi
compose stop > /dev/null
out="$(compose run --rm --no-deps -T fireside fireside restore "$backup")"
grep -q 'Restored' <<< "$out"
compose start > /dev/null
wait_healthy
out="$(compose exec -T fireside fireside keys list)"
if grep -q smoke-test <<< "$out"; then
  echo "::error::restore did not replace the database"
  exit 1
fi
if ! find "$backups" -maxdepth 1 -name 'fireside-pre-restore-*.db' | grep . >/dev/null; then
  echo "::error::restore kept no copy of the previous database"
  exit 1
fi
# The restored database and the copy `restore` kept, written by a one-off container.
expect_private

echo "Smoke test OK."
