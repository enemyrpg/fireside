#!/usr/bin/env bash
# Installs the server as a systemd user service (running without Docker).
# Renders deploy/systemd/server.service.in into
# ~/.config/systemd/user/<name>.service with absolute paths, then enables and
# starts it. See README "Autostart".
#
# Usage: scripts/systemd/install.sh [options]
#   --node <path>   Run this node binary instead of finding one (see below).
#                   With --tunnel it only picks the Node that reads the names
#                   from shared/src/branding.ts: the tunnel unit runs no Node.
#   --print         Only print the unit, change nothing
#   --no-enable     Write the unit, but don't enable or start it
#   --uninstall     Stop, disable and remove the service
#   --tunnel        Act on the Cloudflare Tunnel service (cloudflared) instead
#                   of the server: <name>-tunnel.service, from
#                   deploy/systemd/tunnel.service.in. Combine with --print,
#                   --no-enable or --uninstall. See docs/tunnel.md.
#   --cloudflared <path>
#                   With --tunnel: run this cloudflared instead of the one on
#                   PATH. Needs 2025.4.0 or later (--token-file).
#
# The tunnel token is read from <repo>/secrets/tunnel-token, which must be a
# file with mode 0600 owned by you. It is never put in the unit. Run
# cloudflared one way only: this service or the Docker profile, never both.
#
# Finding Node:
#   1. --node <path>, if given.
#   2. fnm, if installed. The unit does not store a node path: every time the
#      service starts it asks fnm for the installed version that matches the
#      repo's .node-version (the version Docker and CI use) and runs that
#      binary directly. A Node update within that major (`fnm install`) is
#      picked up on the next restart, removing an old version doesn't break the
#      service, and it doesn't depend on fnm's per-shell PATH or `fnm default`.
#   3. Otherwise the node on PATH, resolved to its real path.
#   With --tunnel, Node only reads the names, so the node on PATH comes before
#   fnm, and no version has to match .node-version.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
template="$repo_root/deploy/systemd/server.service.in"
node_version_file="$repo_root/.node-version"

node_path=''
cloudflared_path=''
tunnel=no
mode=install
while [ $# -gt 0 ]; do
  case "$1" in
    --node)
      [ $# -ge 2 ] || { echo 'error: --node needs a path' >&2; exit 2; }
      node_path="$2"
      shift 2
      ;;
    --print) mode=print; shift ;;
    --no-enable) mode=no-enable; shift ;;
    --uninstall) mode=uninstall; shift ;;
    --tunnel) tunnel=yes; shift ;;
    --cloudflared)
      [ $# -ge 2 ] || { echo 'error: --cloudflared needs a path' >&2; exit 2; }
      cloudflared_path="$2"
      shift 2
      ;;
    # The comment block at the top of this file, up to the first line of code.
    -h | --help) awk 'NR > 1 && !/^#/ { exit } NR > 1' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "error: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
done

fail() { echo "error: $*" >&2; exit 1; }

[ -z "$cloudflared_path" ] || [ "$tunnel" = yes ] || fail '--cloudflared only works with --tunnel'

# systemd treats %, \, " and $ specially in unit files (ExecStart expands
# $NAME), and paths with them are rare.
case "$repo_root" in
  *[%\\\"\$]* | *$'\n'*) fail "the repo path contains %, \\, \", \$ or a newline: $repo_root" ;;
esac

# --- Node --------------------------------------------------------------------
fnm_bin=''
if [ -n "$node_path" ]; then
  [ -x "$node_path" ] || fail "not an executable: $node_path"
  node_path="$(realpath "$node_path")"
  run_node() { "$node_path" "$@"; }
elif [ "$tunnel" = yes ] && node_on_path="$(command -v node)"; then
  # The tunnel unit runs no Node: any node that can read branding.ts will do.
  node_path="$(realpath "$node_on_path")"
  run_node() { "$node_path" "$@"; }
elif fnm_bin="$(command -v fnm)"; then
  fnm_bin="$(realpath "$fnm_bin")"
  [ -f "$node_version_file" ] || fail "missing $node_version_file"
  run_node() { "$fnm_bin" exec --using="$node_version_file" node "$@"; }
  run_node --version > /dev/null 2>&1 ||
    fail "fnm has no Node matching $node_version_file ($(cat "$node_version_file")). Run: fnm install $(cat "$node_version_file")"
else
  node_on_path="$(command -v node)" || fail 'node not found. Install Node, or pass --node <path>'
  node_path="$(realpath "$node_on_path")"
  case "$node_path" in
    */.nvm/* | */nvm/*)
      echo "warning: $node_path is from nvm and changes when you switch versions." >&2
      echo '         Run this script again after changing Node.' >&2
      ;;
  esac
  run_node() { "$node_path" "$@"; }
fi

# --- Names from shared/src/branding.ts (never hardcoded) ---------------------
# Node 26 runs the TypeScript source directly (type stripping), so this works
# before `pnpm build` too.
branding="$repo_root/shared/src/branding.ts"
names="$(run_node --input-type=module -e \
  "const { BRANDING } = await import(process.argv[1]); console.log(BRANDING.shortName + '\n' + BRANDING.displayName)" \
  "$branding")"
short_name="$(sed -n 1p <<< "$names")"
display_name="$(sed -n 2p <<< "$names")"
[ -n "$short_name" ] || fail "could not read the name from $branding"

unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
if [ "$tunnel" = yes ]; then
  unit_name="$short_name-tunnel.service"
  template="$repo_root/deploy/systemd/tunnel.service.in"
else
  unit_name="$short_name.service"
fi
unit_file="$unit_dir/$unit_name"

if [ "$mode" = uninstall ]; then
  systemctl --user disable --now "$unit_name" 2> /dev/null || true
  rm -f "$unit_file"
  systemctl --user daemon-reload
  echo "Removed $unit_file"
  exit 0
fi

# --- cloudflared (--tunnel) -----------------------------------------------------
token_file="$repo_root/secrets/tunnel-token"
cloudflared_bin=''
if [ "$tunnel" = yes ]; then
  if [ -n "$cloudflared_path" ]; then
    [ -x "$cloudflared_path" ] || fail "not an executable: $cloudflared_path"
    cloudflared_bin="$(realpath "$cloudflared_path")"
  else
    found="$(command -v cloudflared)" ||
      fail 'cloudflared not found. Install it (e.g. pacman -S cloudflared), or pass --cloudflared <path>'
    cloudflared_bin="$(realpath "$found")"
  fi
  case "$cloudflared_bin" in
    *[%\\\"\$]* | *$'\n'*) fail "the cloudflared path contains %, \\, \", \$ or a newline: $cloudflared_bin" ;;
  esac
  # --token-file needs 2025.4.0 or later. Output: "cloudflared version 2026.11.1 (built …)".
  version="$("$cloudflared_bin" --version 2> /dev/null | sed -n 's/^cloudflared version \([0-9][0-9.]*\).*/\1/p' | head -n 1)"
  [ -n "$version" ] || fail "could not read the version of $cloudflared_bin"
  if [ "$(printf '%s\n' 2025.4.0 "$version" | sort -V | head -n 1)" != 2025.4.0 ]; then
    fail "cloudflared $version is too old: --token-file needs 2025.4.0 or later"
  fi
fi

# The token file: a regular file (not a link), mode 0600, owned by this user.
check_token_file() {
  [ -f "$token_file" ] && [ ! -L "$token_file" ] ||
    fail "missing $token_file. Put the tunnel token there first (docs/tunnel.md)"
  [ "$(stat -c '%u' "$token_file")" = "$(id -u)" ] || fail "$token_file must be owned by you"
  local mode
  mode="$(stat -c '%a' "$token_file")"
  [ "$mode" = 600 ] || fail "$token_file has mode $mode, must be 600. Run: chmod 600 $token_file"
}

check_built() {
  for built in server/dist/index.js web/dist/index.html; do
    [ -f "$repo_root/$built" ] || fail "missing $built. Run: pnpm install; pnpm build"
  done
}

# --- Render ------------------------------------------------------------------
# In ExecStart, systemd expands $NAME itself, so the shell's $ are written $$.
if [ -n "$fnm_bin" ]; then
  # Resolve the node binary at every start, then exec it, so node is the main
  # process (signals, exit codes and logs go straight to systemd). If fnm has
  # no matching version, exit 78 so systemd doesn't retry every 5 seconds.
  exec_start="/bin/sh -c 'node=\"\$\$(\"\$\$0\" exec --using=\"\$\$1\" node -p process.execPath)\" || exit 78; exec \"\$\$node\" \"\$\$2\"' \"$fnm_bin\" \"$node_version_file\" \"$repo_root/server/dist/index.js\""
  extra_environment=''
  # fnm finds its versions in FNM_DIR, or ~/.local/share/fnm without it.
  if [ -n "${FNM_DIR:-}" ]; then extra_environment="Environment=\"FNM_DIR=$FNM_DIR\""; fi
else
  exec_start="\"$node_path\" \"$repo_root/server/dist/index.js\""
  extra_environment=''
fi

render() {
  # Literal replacement (no sed: paths may contain & or |).
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line//@EXEC_START@/$exec_start}"
    line="${line//@REPO_ROOT@/$repo_root}"
    line="${line//@SHORT_NAME@/$short_name}"
    line="${line//@DISPLAY_NAME@/$display_name}"
    line="${line//@CLOUDFLARED@/$cloudflared_bin}"
    line="${line//@TOKEN_FILE@/$token_file}"
    if [ "$line" = '@EXTRA_ENVIRONMENT@' ]; then
      [ -n "$extra_environment" ] && printf '%s\n' "$extra_environment"
      continue
    fi
    printf '%s\n' "$line"
  done < "$template"
}

if [ "$mode" = print ]; then
  render
  exit 0
fi

if [ "$tunnel" = yes ]; then check_token_file; else check_built; fi
mkdir -p "$unit_dir"
render > "$unit_file.tmp"
mv "$unit_file.tmp" "$unit_file"
echo "Wrote $unit_file"
systemctl --user daemon-reload

if [ "$mode" = no-enable ]; then
  echo "Start it with: systemctl --user enable --now $unit_name"
  exit 0
fi

systemctl --user enable "$unit_name"
# restart, so a reinstall after `pnpm build` runs the new code.
systemctl --user restart "$unit_name" || true
sleep 2
if [ "$tunnel" = yes ]; then service_label="$display_name Cloudflare Tunnel"; else service_label="$display_name"; fi
if systemctl --user is-active --quiet "$unit_name"; then
  echo "$service_label is running."
  if [ "$tunnel" = yes ]; then
    echo "Check the log for \"Registered tunnel connection\": journalctl --user -u $unit_name -n 20"
  fi
elif [ "$tunnel" = yes ]; then
  echo "$service_label did not start. Last log lines:" >&2
  journalctl --user -u "$unit_name" -n 15 --no-pager >&2 || true
  exit 1
else
  echo "$display_name did not start. Last log lines:" >&2
  journalctl --user -u "$unit_name" -n 15 --no-pager >&2 || true
  echo >&2
  echo "If it says \"already running\", stop the other server (Docker or pnpm dev)," >&2
  echo "then run: systemctl --user restart $unit_name" >&2
  exit 1
fi

cat << EOF

Status:  systemctl --user status $unit_name
Logs:    journalctl --user -u $unit_name -f
Restart: systemctl --user restart $unit_name$([ "$tunnel" = yes ] || echo '   (after pnpm build)')
EOF

if [ "$(loginctl show-user "$USER" --property=Linger --value 2> /dev/null)" = yes ]; then
  echo 'Lingering is on: the service starts at boot, without logging in.'
else
  echo 'The service starts when you log in and stops when you log out.'
  echo "To start it at boot without logging in: loginctl enable-linger $USER"
fi
