#!/bin/sh
# Switches a workspace machine off when no page has been connected for a while
# (docs/workspaces.md). Run every two minutes by ide-idle.timer, as root.
#
# "Connected" is the host's own word (--active-file): it writes the time into
# /run/ide/active every half minute while a page that showed the code is connected. A
# connection that never shows the code doesn't count, so a stranger opening sockets to the
# proxy can't keep a machine running.
#
# This is a convenience for the person, not the limit on what a machine may cost: someone
# with root on their machine can stop this timer. The service that started the machine counts
# its running time and stops it from outside.
set -eu
[ -r /run/ide/env ] && . /run/ide/env
limit=${IDE_IDLE_MINUTES:-30}
case "$limit" in '' | *[!0-9]*) limit=30 ;; esac
[ "$limit" -gt 0 ] || exit 0
now=$(date +%s)
last=$(cat /run/ide/active 2>/dev/null || echo "$now")
case "$last" in '' | *[!0-9]*) last=$now ;; esac
if [ $((now - last)) -ge $((limit * 60)) ]; then
  logger -t ide-idle "no page connected for $limit minutes: switching off"
  systemctl poweroff
fi
