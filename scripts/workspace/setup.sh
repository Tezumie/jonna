#!/bin/sh
# Turns a fresh Ubuntu 24.04 machine into a workspace machine (docs/workspaces.md): the proxy,
# the host as a service of the user `dev`, common tools, and the switch-off when idle. Run it
# once as root with the host program beside it, then make an image of the machine's disk:
#
#   sudo sh setup.sh ./ide-host
#
# Nothing here names a product or a cloud: boot.sh reads who may connect when a machine starts.
set -eu
host=${1:-./ide-host}
here=$(dirname "$0")
[ -x "$host" ] || [ -f "$host" ] || { echo "setup: give the host program (ide-host)" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "setup: run as root" >&2; exit 2; }

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# What the editor itself runs is all here: git, the GitHub CLI (its GitHub sign-in is
# `gh auth login`), ripgrep, ssh, ps and ping. The rest is what people expect on a machine.
apt-get install -y -qq caddy git git-lfs gh openssh-client curl ca-certificates build-essential \
  pkg-config python3 python3-pip python3-venv unzip zip jq ripgrep iproute2 iputils-ping procps \
  less nano xz-utils libdbus-1-3 >/dev/null

# Node.js: the current LTS line from nodejs.org, checked against its published SHA-256.
node_line=${NODE_LINE:-v22}
sums=$(curl -fsSL "https://nodejs.org/dist/latest-$node_line.x/SHASUMS256.txt")
file=$(printf '%s\n' "$sums" | awk '/linux-x64\.tar\.xz$/ { print $2 }')
want=$(printf '%s\n' "$sums" | awk '/linux-x64\.tar\.xz$/ { print $1 }')
[ -n "$file" ] && [ -n "$want" ] || { echo "setup: no Node.js build listed" >&2; exit 1; }
curl -fsSL -o "/tmp/$file" "https://nodejs.org/dist/latest-$node_line.x/$file"
[ "$(sha256sum "/tmp/$file" | awk '{ print $1 }')" = "$want" ] || { echo "setup: Node.js download doesn't match its checksum" >&2; exit 1; }
tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner
rm -f "/tmp/$file"

# The person's user: theirs to run as root (it is their machine), never the service's.
id dev >/dev/null 2>&1 || useradd -m -s /bin/bash dev
printf 'dev ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/dev
chmod 0440 /etc/sudoers.d/dev
install -d -o dev -g dev /home/dev/projects

install -d /opt/ide
install -m 0755 "$host" /opt/ide/ide-host
install -m 0755 "$here/boot.sh" /opt/ide/boot.sh
install -m 0755 "$here/idle.sh" /opt/ide/idle.sh
install -m 0644 "$here/ide-boot.service" "$here/ide-host.service" \
  "$here/ide-idle.service" "$here/ide-idle.timer" /etc/systemd/system/

# The proxy waits for boot.sh's file.
install -d /etc/systemd/system/caddy.service.d
printf '[Unit]\nAfter=ide-boot.service\nRequires=ide-boot.service\n' \
  > /etc/systemd/system/caddy.service.d/ide.conf

# Room to build on a small machine.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

systemctl daemon-reload
systemctl enable ide-boot.service ide-host.service ide-idle.timer caddy.service >/dev/null
apt-get clean
echo "setup: done. Stop this machine and make an image of its disk."
