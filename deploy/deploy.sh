#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

root=/opt/vb-bot
release_id=${1:?Pass a release ID}
[[ $release_id =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || { echo 'Invalid release ID' >&2; exit 1; }
[[ $EUID -eq 0 ]] || exit 1
incoming="$root/incoming/$release_id"
release="$root/releases/$release_id"
install -d -m 0700 "$root" "$root/releases" "$root/status"
exec 9>/run/lock/vb-bot-deploy.lock
flock -w 1800 9

previous=''
if [[ -L $root/current ]]; then
  previous=$(readlink -f "$root/current")
fi
switched=0
status_file="$root/status/$release_id"
printf 'running\n' > "$status_file"
compose() {
  local directory=$1
  shift
  BOT_IMAGE="vb-bot:$(basename "$directory")" docker compose --project-name vb-bot \
    --env-file "$directory/.env" -f "$directory/compose.yaml" "$@"
}
activate() {
  ln -sfn "$1" "$root/current.next"
  mv -Tf "$root/current.next" "$root/current"
}
finish() {
  local result=$?
  trap - EXIT
  if (( result != 0 )); then
    echo "Deployment failed (exit $result)."
    if (( switched )); then
      if [[ -n $previous && -f $previous/compose.yaml ]]; then
        echo "Restoring previous release: $(basename "$previous")"
        activate "$previous"
        compose "$previous" up -d --no-build --pull never --remove-orphans --wait --wait-timeout 180 \
          && compose "$previous" run --rm --no-deps bot node src/register.js \
          || echo 'Rollback needs attention; inspect the deployment journal.' >&2
      else
        # First deployment has nothing to restore. Leave MongoDB and its data intact.
        compose "$release" rm --stop --force bot || true
        rm -f "$root/current"
      fi
    fi
    printf 'failed\n' > "$status_file"
  else
    printf 'success\n' > "$status_file"
  fi
  exit "$result"
}
trap finish EXIT

[[ -d $incoming && ! -e $release ]] || { echo 'Missing upload or release already exists.' >&2; exit 1; }
mv "$incoming" "$release"
mv "$release/runtime.env" "$release/.env"
chmod 0600 "$release/.env"
bash "$release/deploy/bootstrap.sh"
compose "$release" config --quiet

# Build while the current release stays online; no secret files enter the image.
compose "$release" build --pull bot
# Prepare the database and verify authentication before replacing the working bot.
compose "$release" up -d --wait --wait-timeout 180 mongodb
compose "$release" run --rm --no-deps bot node --input-type=module -e '
  import { MongoClient } from "mongodb";
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try { await client.connect(); await client.db(process.env.MONGODB_DATABASE).command({ ping: 1 }); }
  finally { await client.close(); }
'

install -m 0755 "$release/deploy/control.sh" /usr/local/sbin/vb-bot-control
install -m 0644 "$release/deploy/vb-bot.service" /etc/systemd/system/vb-bot.service
install -m 0644 "$release/deploy/vb-bot-watchdog.service" /etc/systemd/system/vb-bot-watchdog.service
install -m 0644 "$release/deploy/vb-bot-watchdog.timer" /etc/systemd/system/vb-bot-watchdog.timer
systemctl daemon-reload
systemctl enable vb-bot.service vb-bot-watchdog.timer
# Set rollback intent before activation so signals cannot skip restoring the old release.
switched=1
activate "$release"
compose "$release" up -d --no-deps --no-build --pull never --force-recreate --remove-orphans --wait --wait-timeout 240 bot
compose "$release" run --rm --no-deps bot node src/register.js
systemctl start vb-bot-watchdog.timer
# Do not wait on the boot service while holding its lock.
systemctl start --no-block vb-bot.service

# Keep this release and the previous working release; delete only our own older releases.
for old in "$root"/releases/*; do
  [[ -d $old && $old != "$release" && $old != "$previous" ]] || continue
  old_id=$(basename "$old")
  [[ $old_id =~ ^[0-9a-f]{40}-[0-9]+-[0-9]+$ ]] || continue
  docker image rm "vb-bot:$old_id" >/dev/null 2>&1 || true
  rm -rf -- "$old"
done
# The source archive is no longer needed after successful extraction/deployment.
rm -f "$release/bundle.tar.gz"
echo "Deployment healthy: $release_id"
