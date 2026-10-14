# Voice activity bot

A Node.js Discord bot with blue embeds, MongoDB storage, and a blue PNG voice-time leaderboard. Each Discord server has its own monitored channel, alert destination, custom message, and statistics.

## Run with Docker Compose

1. Install Docker with the Compose plugin.
2. Create a bot in the [Discord Developer Portal](https://discord.com/developers/applications). Copy `.env.example` to `.env`, fill in `DISCORD_TOKEN` and `CLIENT_ID` (application ID), and replace `MONGO_ROOT_PASSWORD` with a long random alphanumeric password. Leave `GUILD_ID` blank for global commands across all servers; set it only for a single development server.
3. Optionally add trusted Discord user IDs as quoted strings to `WHITELISTED_USER_IDS` in `config.js`. These users can manage settings in any server where they can invoke the bot. Each server's owner is automatically authorized in their own server. Administrators are not otherwise authorized.
4. Invite the application to each server with the `bot` and `applications.commands` scopes. Grant **View Channel**, **Send Messages**, **Embed Links**, and **Attach Files** where it operates; also grant **Connect** if posting to voice-channel chat. The bot does not join voice or record audio. No privileged intents are required.
5. Build, register the commands, and start the services:

```sh
docker compose build
docker compose run --rm --no-deps bot node src/register.js
docker compose up -d
docker compose logs -f bot
```

Compose starts MongoDB, waits for its health check, then starts the bot. MongoDB uses authentication, an internal network, and a persistent named volume; no database port is exposed on the host. The bot has a separate network for Discord access. Credentials are provided through environment variables and are excluded from the image.

To copy Discord IDs, enable **User Settings → Advanced → Developer Mode**, then right-click a server, channel, or user and choose **Copy ID**. Never commit `.env` or share your bot token.

## Commands

| Command | Access | Result |
| --- | --- | --- |
| `/configure voice-channel-id:123456789012345678` | This server's owner / code whitelist | Monitors that channel and posts alerts to its voice-channel chat. |
| `/configure voice-channel-id:123456789012345678 alerts-channel:#general message:Someone needs company!` | This server's owner / code whitelist | Sets this server's channel, alert destination, and message together. |
| `/message text:Come join the voice channel!` | This server's owner / code whitelist | Changes only this server's alert text. Configure a channel first. |
| `/alert-channel channel:#alerts` | This server's owner / code whitelist | Saves this server's alert destination in MongoDB. Configure a voice channel first. |
| `/leaderboard` | Everyone with access to the command | Posts a blue PNG with member avatars and the top 10 individual user VC times. |
| `/mytime` | Everyone with access to the command | Publicly posts a blue image card with your avatar, name, and total time in this server's configured voice channel, including your current session. Requires Embed Links and Attach Files. |
| `/leaderboard-channel channel:#leaderboard` | This server's owner / code whitelist | Posts a leaderboard, then deletes and reposts it with an updated image every 30 seconds. |
| `/leaderboard-stop` | This server's owner / code whitelist | Stops automatic updates, leaving the last image in place. |

`/alert-channel` accepts a text channel or voice-channel chat. The bot needs **View Channel**, **Send Messages**, and **Embed Links** there (plus **Connect** for voice-channel chat). Changing the destination preserves voice times and the custom message; an already-delivered solo alert is not resent.

The persistent leaderboard includes member avatars and individual user VC times, just like `/leaderboard`. Configure the monitored voice channel first. Grant the bot **View Channel**, **Send Messages**, **Embed Links**, **Attach Files**, and **Read Message History** in the leaderboard channel (plus **Connect** for voice-channel chat).

Each server has one automatically updated leaderboard. Its channel/message IDs are saved in MongoDB, and the bot refreshes it on startup and every 30 seconds while connected. Each refresh builds a new image, deletes the previous bot message, and sends a new message at the bottom of the channel. Running `/leaderboard-channel` again in the same channel also replaces the message; choosing a different channel moves it and attempts to remove the old bot message. A deleted leaderboard message is recreated on the next update. Missing channel permissions or network errors are logged and retried at the next interval. If sending fails after deletion, the leaderboard is absent until a retry succeeds. Changing the monitored voice channel shows the newly configured channel's statistics on the next update. `/leaderboard-stop` stops reposting and leaves the last message in place.

After installing this update, rerun `npm run register` (or the Docker registration command above) to expose the new slash commands. The GitHub deployment workflow registers them automatically.

With exactly one connected human in the configured voice channel, the bot sends a blue embed with **only one person in vc** by default. Custom text supports Discord Markdown, has a 4,000-character limit, and cannot be blank. Mentions in custom messages do not ping users or roles. Omitting `message` when reconfiguring preserves the existing message. `/message` changes the text used for future alerts, without resending an already-delivered solo alert.

The bot checks every **five seconds**. It sends once per solo stay, resetting when the channel becomes empty, contains multiple humans, or a different person is alone. Failed sends retry at the next check. Reconfiguring or reconnecting resets the alert. Bots are ignored; muted and deafened humans count. “Active” means connected, not speaking.

## Persistence and operation

- MongoDB's `guilds` collection stores channel IDs and alert text by Discord server ID. `voice_totals` stores separate records keyed by server, channel, and user. One server's settings and totals never affect another's.
- Voice events capture joins/leaves between polls. Totals are saved every five seconds, on commands, and on normal shutdown. Writes are serialized and idempotent to prevent older checkpoints overwriting newer ones.
- Changing channels preserves earlier totals. Switching back restores that channel's leaderboard. Online sessions contribute to leaderboard totals immediately.
- The leaderboard displays each member's server avatar (or their global/default avatar), falling back to an initial if the picture is unavailable. Saved avatars can also be used for members who have left the server.
- Time while the bot is offline or disconnected is excluded. Users already connected at startup are tracked from startup. A sudden crash/disconnect may lose time since the latest checkpoint (normally at most five seconds). A solo stay may alert again after restart.
- Run **one bot process** for this token/database; it supports many Discord servers. Multiple replicas sharing live session tracking are not supported.
- MongoDB data survives `docker compose down` and rebuilds. **`docker compose down -v` deletes the database volume.** Use MongoDB backup tools before deleting volumes. Root credentials initialize a new volume only; editing `.env` does not change credentials in an existing database.
- Deleted or inaccessible alert channels produce log errors; run `/alert-channel` with a valid channel. A database failure during polling stops the bot so Compose can restart it; failed command writes report an error and can retry on the next checkpoint.
- After changing the whitelist, run `docker compose up -d --build bot`. After changing command definitions, rerun registration. Registration replaces this app's commands in the chosen scope. Remove old server-scoped registrations if you switch to global registration and see duplicates.

## Local development

Install Node.js **24.17.0 or newer** and run `npm ci`. Provide your own running MongoDB (local or hosted) through `MONGODB_URI` in `.env`, then run:

```sh
npm run register
npm start
```

Compose supplies its own internal MongoDB URI; the `.env` URI is only for running Node directly. If your MongoDB URI credentials contain special characters, URL-encode them. On minimal Linux hosts, install DejaVu Sans for image text; the Docker image includes fonts.

```sh
npm test
npm run preview
```

Tests use an in-memory MongoDB collection double to check persistence round trips, serialized writes, server isolation, authorization, voice timing, alert retries, and image generation without credentials. `npm run preview` creates `preview/leaderboard.png` with sample data. A live Discord/MongoDB smoke test still requires running the infrastructure and supplying a token.

References: [discord.js](https://discord.js.org/docs/packages/discord.js/14.27.0), [MongoDB Node.js driver](https://www.mongodb.com/docs/drivers/node/current/connect/), [Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/), and [@napi-rs/canvas](https://github.com/Brooooooklyn/canvas).

## Automatic deployment to Ubuntu

[The deployment workflow](.github/workflows/deploy.yml) runs on pushes to `main` and manual dispatches from `main`, targeting **root@154.12.224.147**. It provisions Docker Engine/Compose from Docker's official Ubuntu repository on the first deployment. Use a supported 64-bit Ubuntu release with systemd (22.04/24.04/26.04); the server needs outbound HTTPS and Discord access, and SSH port 22 must be reachable from the GitHub runner.

Create these GitHub Actions secrets in the **production** environment (repository-level secrets also work):

| Secret | Value |
| --- | --- |
| `DEPLOY_USERNAME` | SSH username; defaults to `root` if omitted. Deployment requires the root account to install Docker and manage system services. |
| `DEPLOY_PASSWORD` | The server's SSH login password. Required. |
| `DISCORD_TOKEN` | Your Discord bot token from the Developer Portal. Required. |
| `CLIENT_ID` | Your Discord application ID. Required. |
| `MONGO_ROOT_PASSWORD` | A long random alphanumeric MongoDB password. Required; keep it unchanged across redeployments unless you migrate the database credentials separately. |
| `GUILD_ID` | Optional development-server ID. Omit for global commands across all servers. |

Optional Actions **variables**: `MONGO_ROOT_USERNAME` (defaults to `voicebot`) and `MONGODB_DATABASE` (defaults to `voice_bot`). Keep these unchanged for an existing deployment unless you migrate it separately.

The workflow builds the server's private `.env` file from these individual secrets without printing their values. `DEPLOY_ENV_FILE` is no longer used. If you previously used that combined secret, copy its values into the new secrets before deploying. For manual local/Compose use, continue using `.env.example` as usual.

The workflow uses `sshpass` with the password supplied through an environment variable, never a command-line argument or uploaded file. `DEPLOY_SSH_KEY` is no longer used. The server must already permit SSH password authentication and root password login (`PasswordAuthentication yes` and `PermitRootLogin yes` in its effective SSH configuration). The workflow checks root access before uploading the release.

SSH host-key verification is disabled for this workflow. No known-hosts secret is required; the connection does not verify the server's identity.

Then push the project to `main` or run **Actions → Test and deploy voice bot → Run workflow**. No separate server checkout or manual npm install is needed. Protect `main` and the production environment: code deployed by this workflow executes as root on this server.

Deployment behavior:

- Runs the test suite, shell checks, a Docker build, and a real MongoDB/image smoke test on the runner before touching production.
- Uploads the exact Git commit into a fresh release directory. Runs deployment as a detached systemd job, so an SSH interruption does not stop the server-side build/deployment; the runner retries status reads.
- Builds the new image while the current release remains online, checks MongoDB authentication, recreates the bot container, waits for health, and registers slash commands. There is a short bot interruption during replacement.
- Replaces the active deployment via `/opt/vb-bot/current`, using the fixed Compose project name `vb-bot`. It removes obsolete containers belonging to this project and keeps only the active and previous successful releases after deployment. Unrelated server services are untouched.
- On a normal deployment failure after cutover, restores the previous release/image and command definitions. On a failed first deployment, removes the failed bot container while retaining MongoDB for a retry. A forced kill or server reboot during the deployment itself can interrupt rollback; inspect the journal and rerun the workflow after the server returns.
- MongoDB's `vb-bot_mongo_data` volume survives all deployments and rollbacks. **Application replacement does not erase statistics.** Keep off-server database backups separately; the volume does not protect against disk loss.
- GitHub concurrency and a server-side lock serialize deployments and prevent the watchdog from restarting containers during deployment. Each release has its own root-readable `.env`; secrets are never baked into the image.

Recovery behavior:

- Docker/containerd are enabled at boot. Both containers use `restart: always`; the enabled `vb-bot.service` also reconciles the Compose stack after reboot and retries failed startup.
- Bot health requires a successful Discord-ready monitoring cycle and a MongoDB ping within the last 90 seconds. Dead connections, blocked event loops, and failed database connectivity therefore become unhealthy or exit.
- `vb-bot-watchdog.timer` checks every minute and restarts unhealthy/exited containers, including MongoDB. Docker restart policies alone do not restart a running-but-unhealthy container. Recovery typically takes a few minutes; external outages will keep retrying until service returns.
- Container logs rotate at 10 MB, retaining three files per service. The current and previous application images are retained for rollback; Docker build cache may still need periodic operator cleanup on small disks.

Useful server commands:

```sh
systemctl status vb-bot.service vb-bot-watchdog.timer
journalctl -u vb-bot-watchdog.service -n 100 --no-pager
# The workflow prints the exact deployment journal unit on failure:
journalctl -u 'vb-bot-deploy-*' --since today --no-pager
cat /opt/vb-bot/status/*
```

For maintenance, disable the watchdog and boot unit first, then stop the project's containers; otherwise they are intentionally recovered. A routine server reboot needs no intervention after a successful deployment.

Infrastructure references: [Docker Ubuntu installation](https://docs.docker.com/engine/install/ubuntu/), [Docker restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/), and [GitHub Actions secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets).
