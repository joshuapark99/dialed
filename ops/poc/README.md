# Raspberry Pi POC operations

This runbook hosts Dialed on one 64-bit Raspberry Pi behind a remotely managed Cloudflare Tunnel and Cloudflare Access. The Pi opens no inbound application, database, or SSH port. GitHub Actions publishes images; a systemd timer on the Pi pulls and verifies them.

This is a proof of concept, not a high-availability production service. Keep the Pi patched, retain off-device backups, and expect brief downtime during deployments.

## 1. Prepare the host

Use a Raspberry Pi 4 with at least 4 GB RAM or a Pi 5, a 64-bit Raspberry Pi OS installation, and a USB SSD for application data and backups. Confirm the architecture:

```bash
uname -m
```

It must report `aarch64`. Install Docker Engine from Docker's supported Debian instructions and Docker Compose v2.24 or newer. Add the normal administrator to the `docker` group only if that access is intended; Docker access is root-equivalent.

```bash
docker info
docker compose version
```

Clone a reviewed revision of this public repository onto the Pi. Host assets change only when an operator updates that checkout and reruns `sudo ops/poc/bin/install`; normal application CD changes containers only.

## 2. Prepare SSD storage and secrets

Choose two absolute, dedicated SSD-backed child paths. Do not use a mount point or broad system directory such as `/`, `/mnt`, or `/var`; the installer creates missing directories as root with mode `0700` and rejects unsafe existing permissions. The data and backup paths must not contain one another. Backups on the same SSD help with deployment recovery but do not protect against device loss, so copy them off the Pi separately.

Run the installer once to place the value-free template:

```bash
sudo ops/poc/bin/install
```

The first run stops and asks for `/etc/dialed/poc.env`. Create it without exposing values in shell history:

```bash
sudo install -o root -g root -m 0600 /etc/dialed/poc.env.example /etc/dialed/poc.env
sudoedit /etc/dialed/poc.env
```

Fill every value. `APP_URL` is the exact public HTTPS origin without a trailing slash. Generate URL-safe secrets, for example with `openssl rand -base64 48 | tr -d '\n'`; `BETTER_AUTH_SECRET` must contain at least 32 random bytes. Keep `POSTGRES_PASSWORD` URL-safe because it is interpolated into `DATABASE_URL`.

Example path choices:

```dotenv
DIALED_DATA_DIR=/mnt/dialed-ssd/data
DIALED_BACKUP_DIR=/mnt/dialed-ssd/backups
```

Verify the file remains owned by root and unreadable by other users:

```bash
sudo chown root:root /etc/dialed/poc.env
sudo chmod 0600 /etc/dialed/poc.env
sudo stat -c '%U:%G %a %n' /etc/dialed/poc.env
```

The installer deliberately never overwrites this file.

## 3. Configure Cloudflare Tunnel and Access

In Cloudflare Zero Trust, create a remotely managed named tunnel and select the Docker connector. Copy only its tunnel token into `TUNNEL_TOKEN` on the Pi. Do not use a Quick Tunnel and do not put the tunnel token in GitHub.

Create the public hostname but leave it disabled until local validation is complete. Its service is exactly:

```text
http://web:3000
```

Enable the route's **Protect with Access** option and associate it with the POC Access application. This origin-side protection is required in addition to creating Access policies; requests reaching the connector without a valid Access identity or service token must be rejected.

Create one Access self-hosted application for the POC hostname with a 24-hour session and default-deny behavior. Add:

- an Allow policy containing only the owner's and invited testers' exact email addresses; One-time PIN is sufficient for the POC;
- a Service Auth policy containing one narrowly scoped Access service token for GitHub's external health check.

Requests that match neither policy must be denied. Store the service token ID and secret only in the GitHub environment described below. Cloudflare Access protects the origin but does not replace Dialed's own Google login for cloud sync.

### Access lifecycle

Cloudflare Access is used here as a private-POC and closed-beta gate, not as Dialed's final user-account system. Access decides who may reach the hostname; Dialed authentication owns application identity, account-scoped data, synchronization, and account recovery. If Google OAuth is not configured, an Access-approved tester still uses Dialed anonymously and their data remains local to that browser and device.

Requiring both Access authentication and Dialed login is acceptable for a small invited test group, but adds unnecessary friction for a public consumer release. For a broader launch, keep the named Cloudflare Tunnel, TLS, and edge protections while removing Access from the public application hostname and relying on Dialed authentication and any application-level invitation flow. Continue to use Access for non-public staging, administrative, and operational endpoints.

## 4. Configure Google OAuth

Set the authorized redirect URI in the Google OAuth client to exactly:

```text
https://YOUR_POC_HOST/api/auth/callback/google
```

This must equal `${APP_URL}/api/auth/callback/google`. Put the client ID and secret in `/etc/dialed/poc.env`, never in an image or repository file.

## 5. Configure GHCR and GitHub

The two packages must be public so the Pi can pull without a registry credential:

- `ghcr.io/joshuapark99/dialed-web`
- `ghcr.io/joshuapark99/dialed-api`

In GitHub, create an environment named `poc` with:

- variable `POC_BASE_URL`: the exact HTTPS origin, without a path or trailing slash;
- secret `CF_ACCESS_CLIENT_ID`: the Access service-token client ID;
- secret `CF_ACCESS_CLIENT_SECRET`: the Access service-token secret.

Only the `main` smoke-verification job uses this environment. The tunnel token and all application/database secrets stay on the Pi. If desired, add required reviewers to the environment; doing so makes external deployment verification wait for approval, but the gated images are published first.

## 6. Install and validate locally

With the Cloudflare public-hostname route still disabled, rerun the installer:

```bash
sudo ops/poc/bin/install
```

It validates architecture, Docker Compose, secret-file ownership and mode, storage paths, and the rendered Compose configuration before enabling either timer. Inspect the schedules and logs:

```bash
systemctl list-timers 'dialed-poc-*'
sudo journalctl -u dialed-poc-deploy.service -n 100 --no-pager
sudo journalctl -u dialed-poc-backup.service -n 100 --no-pager
```

Publish a successful `main` revision, then force reconciliation rather than waiting one minute:

```bash
sudo systemctl start dialed-poc-deploy.service
sudo systemctl status dialed-poc-deploy.service --no-pager
sudo docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml ps
sudo cat /var/lib/dialed/active.env
```

The state file must contain exact `@sha256:` image references and one 40-character revision. No service in `compose.poc.yaml` publishes a host port.

Run and inspect a manual backup:

```bash
sudo /opt/dialed/bin/backup scheduled
sudo sh -c '. /etc/dialed/poc.env; find "$DIALED_BACKUP_DIR" -maxdepth 1 -type f -name "dialed-*.dump" -ls'
```

Copy a backup to another device or storage provider and perform a restore rehearsal before inviting testers.

## 7. Enable and verify the route

Enable the Cloudflare public-hostname route. In a private browser window, confirm an unapproved identity is denied, an invited exact email can pass Access, and Google login returns to Dialed.

The CI deployment check first requests `/healthz` without credentials and requires an Access denial or Cloudflare Access login redirect. It then sends the two Access service-token headers and polls:

- `/healthz` for web status `ok`;
- `/api/readyz` for API/database status `ready`.

Both responses must report the Git commit that produced the images. A published image is not considered deployed until this external check succeeds.

## Routine operation

The deployment timer checks the mutable `:poc` discovery tags each minute, resolves both to exact registry digests, rejects mixed revisions, backs up before migration, runs migrations, starts the candidate, and promotes it only after local health checks pass. It then prunes older Dialed image digests while preserving the active and rollback images. A failed health check restores the prior application image digests; it never restores the database automatically.

Useful commands:

```bash
sudo systemctl start dialed-poc-deploy.service
sudo systemctl start dialed-poc-backup.service
sudo journalctl -fu dialed-poc-deploy.service
sudo docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml ps
sudo docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml logs --tail=200 web api postgres cloudflared
```

To pause application changes while investigating, stop the timer before stopping a running one-shot service:

```bash
sudo systemctl stop dialed-poc-deploy.timer
sudo systemctl stop dialed-poc-deploy.service
```

Re-enable it with:

```bash
sudo systemctl enable --now dialed-poc-deploy.timer
```

### Roll back application images

Automatic rollback occurs after candidate health failure. For a deliberate rollback, pause the deployment timer, inspect both root-only state files, copy `rollback.env` over `active.env`, source the selected exact images, and recreate only the API and web services:

```bash
sudo systemctl stop dialed-poc-deploy.timer
sudo install -o root -g root -m 0600 /var/lib/dialed/rollback.env /var/lib/dialed/active.env
sudo sh -c 'set -a; . /etc/dialed/poc.env; . /var/lib/dialed/active.env; set +a; docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml up --no-deps -d api web'
```

Check local health through the containers, then re-enable the timer only after deciding how to prevent the unwanted `:poc` candidate from immediately being retried. Application rollback assumes migrations are backward compatible with the immediately prior revision.

### Restore PostgreSQL manually

Restoring overwrites logical database contents and is intentionally never automated. First pause deployments and disable the Cloudflare public-hostname route. Verify the selected custom-format dump with `pg_restore --list` on a trusted PostgreSQL 16 host. Preserve an additional copy before proceeding.

The recovery sequence is:

1. Stop `web` and `api` to prevent writes.
2. Take a final safety backup if PostgreSQL is readable.
3. Recreate the target database and restore the chosen dump with `pg_restore --clean --if-exists --no-owner --no-acl` from a trusted administrative context.
4. Run the `migrate` service using the active exact API image.
5. Start `api` and `web`, verify `/readyz` and `/healthz`, then re-enable the Cloudflare route and deployment timer.

Database recreation is destructive. Resolve the exact archive and target database with read-only checks before running it; do not paste a generic destructive command from this guide.

## Updates and credential rotation

Application releases happen through `main`. Host-level changes do not: update the checkout to a reviewed commit and rerun `sudo ops/poc/bin/install`. The installer validates before reloading systemd and preserves `/etc/dialed/poc.env`.

Rotate a credential by pausing the deploy timer, editing the root-only environment file, and running `sudo /opt/dialed/bin/reconcile force`. The force mode recreates the digest-pinned services even when no image changed, then requires application health before recreating the tunnel connector. Rotate the Cloudflare tunnel token in Cloudflare and on the Pi; rotate the Access service token in Cloudflare and GitHub; rotate Google and application secrets at their issuers. A PostgreSQL password change also requires changing the database role password, not only the environment file.

## Teardown

Disable the public hostname first, then stop and disable the timers and stack:

```bash
sudo systemctl disable --now dialed-poc-deploy.timer dialed-poc-backup.timer
sudo sh -c 'set -a; . /etc/dialed/poc.env; . /var/lib/dialed/active.env; set +a; docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml down'
```

Remove the Cloudflare hostname, Access application, service token, and tunnel after the connector is offline. Revoke Google credentials if they are dedicated to the POC.

By default, preserve `/etc/dialed/poc.env`, `/var/lib/dialed`, `DIALED_DATA_DIR`, and `DIALED_BACKUP_DIR`. They contain the only database, deployment state, and recovery material. Delete them only as a separate, explicit data-destruction decision after verifying off-device backups.
