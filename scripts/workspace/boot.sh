#!/bin/sh
# A workspace machine's start: reads who may connect and writes what the host and the proxy
# need (docs/workspaces.md). Runs as root before both, at every boot.
#
# Three values, from the machine's metadata (Google Compute Engine) or from
# /etc/ide/workspace.env on a cloud without such a service:
#   IDE_TOKEN    the code a page must send; new at every start
#   IDE_ORIGIN   the page that may connect (https://app.example.com)
#   IDE_NAME     the name this machine is reached by (the proxy gets its certificate for it);
#                left out, it is made from the public address and IDE_NAME_SUFFIX (sslip.io)
set -eu

md() {
  curl -sf --max-time 5 -H 'Metadata-Flavor: Google' \
    "http://metadata.google.internal/computeMetadata/v1/instance/$1" 2>/dev/null || true
}

IDE_TOKEN=""
IDE_ORIGIN=""
IDE_NAME=""
IDE_NAME_SUFFIX=""
IDE_IDLE_MINUTES=""
if [ -r /etc/ide/workspace.env ]; then
  # shellcheck disable=SC1091
  . /etc/ide/workspace.env
else
  IDE_TOKEN=$(md attributes/ide-token)
  IDE_ORIGIN=$(md attributes/ide-origin)
  IDE_NAME=$(md attributes/ide-name)
  IDE_NAME_SUFFIX=$(md attributes/ide-name-suffix)
  IDE_IDLE_MINUTES=$(md attributes/ide-idle-minutes)
  if [ -z "$IDE_NAME" ]; then
    address=$(md network-interfaces/0/access-configs/0/external-ip)
    [ -n "$address" ] && IDE_NAME="$(printf '%s' "$address" | tr . -).${IDE_NAME_SUFFIX:-sslip.io}"
  fi
fi

# What goes into a unit's arguments and the proxy's file is checked, whoever wrote it.
# One line each: a pattern alone would pass a value whose first line fits and whose next
# one is something else.
ok() { [ "$(printf '%s' "$1" | wc -l)" -eq 0 ] && printf '%s' "$1" | grep -Eq "$2"; }
ok "$IDE_TOKEN" '^[A-Za-z0-9_-]{32,128}$' || { echo "ide-boot: no usable token" >&2; exit 1; }
ok "$IDE_ORIGIN" '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' || { echo "ide-boot: no usable origin" >&2; exit 1; }
ok "$IDE_NAME" '^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$' || { echo "ide-boot: no usable name" >&2; exit 1; }
ok "${IDE_IDLE_MINUTES:-30}" '^[0-9]{1,4}$' || IDE_IDLE_MINUTES=30

install -d -m 0755 /run/ide
umask 077
printf '%s' "$IDE_TOKEN" > /run/ide/token
chown dev:dev /run/ide/token
chmod 0400 /run/ide/token
umask 022
printf 'IDE_ORIGIN=%s\nIDE_NAME=%s\nIDE_IDLE_MINUTES=%s\n' \
  "$IDE_ORIGIN" "$IDE_NAME" "${IDE_IDLE_MINUTES:-30}" > /run/ide/env
# The host writes the time here while a page is connected (idle.sh reads it); a machine that
# just started counts as in use.
date +%s > /run/ide/active
chown dev:dev /run/ide/active

# The proxy carries TLS for the one name and passes everything to the host on this machine.
cat > /etc/caddy/Caddyfile <<EOF
{
	admin off
}
$IDE_NAME {
	reverse_proxy 127.0.0.1:7700
	header -Server
}
EOF
install -d -o dev -g dev /home/dev/projects
