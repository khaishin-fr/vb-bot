#!/usr/bin/env bash
set -Eeuo pipefail

root=${VB_BOT_ROOT:-/opt/vb-bot}
# Share the deploy lock: never restart/reconcile containers during a release change.
exec 9>"${VB_BOT_LOCK:-/run/lock/vb-bot-deploy.lock}"
if [[ ${1:-} == watchdog ]]; then
  flock -n 9 || exit 0
else
  flock -w 1800 9
fi
[[ -L $root/current ]] || exit 0
release=$(readlink -f "$root/current")
BOT_IMAGE="vb-bot:$(basename "$release")"
export BOT_IMAGE
compose=(docker compose --project-name vb-bot --env-file "$release/.env" -f "$release/compose.yaml")

case ${1:-} in
  up)
    "${compose[@]}" up -d --no-build --pull never --remove-orphans --wait --wait-timeout 180
    ;;
  watchdog)
    # An unhealthy process does not trigger Docker's restart policy on its own.
    for service in mongodb bot; do
      container=$("${compose[@]}" ps -a -q "$service")
      if [[ -z $container ]]; then
        "${compose[@]}" up -d --no-build --pull never --remove-orphans
        exit 0
      fi
      state=$(docker inspect --format '{{.State.Status}}' "$container")
      health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")
      if [[ $state == exited || $state == dead || $health == unhealthy ]]; then
        echo "Recovering $service ($state / $health)"
        "${compose[@]}" restart --timeout 30 "$service"
      fi
    done
    ;;
  *) echo 'Usage: control.sh up|watchdog' >&2; exit 2 ;;
esac
