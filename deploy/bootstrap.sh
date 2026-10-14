#!/usr/bin/env bash
set -Eeuo pipefail

[[ $EUID -eq 0 ]] || { echo 'Deployment must run as root.' >&2; exit 1; }
# shellcheck disable=SC1091
source /etc/os-release
[[ $ID == ubuntu ]] || { echo 'This bootstrap requires Ubuntu.' >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl --retry 5 --retry-all-errors -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<APT
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
APT
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 update
  apt-get -o DPkg::Lock::Timeout=120 -o Acquire::Retries=3 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker.service containerd.service

docker compose version
