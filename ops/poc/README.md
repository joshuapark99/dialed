# Raspberry Pi POC operations

This runbook hosts Dialed on one 64-bit Raspberry Pi behind a remotely managed Cloudflare Tunnel and Cloudflare Access. The Pi opens no inbound application, database, or SSH port. GitHub Actions publishes images; a systemd timer on the Pi pulls and verifies them.

This is a proof of concept, not a high-availability production service. Keep the Pi patched, retain off-device backups, and expect brief downtime during deployments.

## 1. Prepare the host

Use a Raspberry Pi 4 with at least 4 GB RAM or a Pi 5, a 64-bit Raspberry Pi OS installation, and a USB SSD for application data and backups. Confirm the architecture:

```bash
uname -m
```

It must report `aarch64`. Install Docker Engine 28 or newer from Docker's supported Debian instructions and Docker Compose v2.24 or newer. Engine 28 is the minimum because older releases can expose ports published to loopback to hosts on the same layer-2 network. Add the normal administrator to the `docker` group only if that access is intended; Docker access is root-equivalent.

```bash
docker info
docker version --format '{{.Server.Version}}'
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

Fill every value. `APP_URL` is the exact public HTTPS origin without a trailing slash. Generate URL-safe secrets, for example with `openssl rand -base64 48 | tr -d '\n'`; `BETTER_AUTH_SECRET` must contain at least 32 random bytes. Keep `POSTGRES_PASSWORD` URL-safe because it is interpolated into `DATABASE_URL`. `SYNC_OPERATION_QUOTA` defaults to `50000` unique ledger operations per account. Keep that value for the friend beta; increasing it requires reviewing Raspberry Pi database capacity.

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

## Local observability

Observability is a local, subordinate Pi service: Grafana, Loki, Prometheus, and Alloy must never be exposed through Cloudflare, the application networks, or the LAN. Grafana is available only at Pi loopback port `3002`; Loki and Prometheus use loopback ports `3100` and `9090`; Alloy diagnostics use loopback port `12345`. A Grafana, Loki, Prometheus, or Alloy failure must not be treated as an application, reconcile, or PostgreSQL-backup failure.

Grafana, Loki, and Prometheus share an internal bridge for service discovery and a separate non-internal bridge that allows Docker Engine to activate their explicit loopback port mappings. The second bridge also gives those three containers outbound network access; it does not attach them to Dialed's application or ingress networks. Docker Engine 28 or newer and the `127.0.0.1` bindings are both required to preserve the no-LAN-exposure boundary.

### Install the pinned host dependency

This POC supports only 64-bit Raspberry Pi OS (`aarch64` or `arm64`). Before the first host-assets install, download and install exactly the ARM64 Alloy `1.19.0-1` Debian package; do not use an APT floating version or `latest`:

```bash
uname -m
curl -fL --proto '=https' --tlsv1.2 \
  -o /tmp/alloy-1.19.0-1.arm64.deb \
  https://github.com/grafana/alloy/releases/download/v1.19.0/alloy-1.19.0-1.arm64.deb
sudo apt install /tmp/alloy-1.19.0-1.arm64.deb
dpkg-query -W -f='${Version}\n' alloy
/usr/bin/alloy --version
```

The package version must be `1.19.0-1` and the Alloy version must be `1.19.0`. Keep the downloaded package only as long as needed for the reviewed installation record; do not substitute a different architecture or release.

### Environment contract and installer

In addition to the existing application values, `/etc/dialed/poc.env` requires the following values. It stays `root:root` and mode `0600`; it is never committed or overwritten by the installer.

```dotenv
# A dedicated absolute SSD child path, disjoint from data and backups.
DIALED_OBSERVABILITY_DIR=/mnt/dialed-ssd/observability

# Default ceiling and reserve, in bytes; choose reviewed capacity values.
DIALED_OBSERVABILITY_MAX_BYTES=5368709120
DIALED_OBSERVABILITY_MIN_FREE_BYTES=10737418240

# No whitespace in the user; password is at least 32 characters.
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=replace-with-a-unique-32-character-or-longer-secret
```

The data, backup, and observability directories must each be absolute, dedicated nested paths and must not contain, or be contained by, another one. The observability path must also be canonical, must not traverse a symbolic link, and may use only letters, digits, `/`, `.`, `_`, and `-` so the installer can encode it literally in reviewed systemd drop-ins. The installer keeps the observability root `root:root` mode `0700`; systemd bind-mounts only the Alloy state and textfile children into Alloy's private runtime path, so Alloy never receives traversal access to that root. After filling the file, install reviewed host assets:

```bash
sudo ops/poc/bin/install
```

The installer verifies the architecture, `/usr/bin/alloy` version, Docker, Compose, storage ownership, both Compose models, Alloy, Loki, and Prometheus configuration. It installs the pinned images `grafana/grafana:13.1.3`, `grafana/loki:3.7.6`, and `prom/prometheus:v3.13.2`, then enables the independent observability stack, metrics timer, storage-guard timer, Alloy, deploy timer, and backup timer.

### Status, login, and routine inspection

The four observability services are Grafana, Loki, Prometheus, and host-native Alloy. Inspect all four, their owning units, and the two observability timers with:

```bash
sudo /opt/dialed/bin/observability status
sudo systemctl status \
  dialed-poc-observability.service \
  dialed-poc-alloy.service \
  dialed-poc-observe.timer \
  dialed-poc-storage-guard.timer --no-pager
sudo journalctl -u dialed-poc-alloy.service -n 200 --no-pager
sudo journalctl -u dialed-poc-observe.service -n 100 --no-pager
sudo journalctl -u dialed-poc-storage-guard.service -n 100 --no-pager
sudo sh -c '. /etc/dialed/poc.env; cat "$DIALED_OBSERVABILITY_DIR/textfile/dialed.prom"'
sudo sh -c '. /etc/dialed/poc.env; du -sh "$DIALED_OBSERVABILITY_DIR" "$DIALED_OBSERVABILITY_DIR/grafana" "$DIALED_OBSERVABILITY_DIR/loki" "$DIALED_OBSERVABILITY_DIR/prometheus"'
sudo sh -c '. /etc/dialed/poc.env; test -e "$DIALED_OBSERVABILITY_DIR/INGESTION_STOPPED" && cat "$DIALED_OBSERVABILITY_DIR/INGESTION_STOPPED" || true'
```

Loki retains logs for fourteen days. Prometheus retains metrics for thirty days or 1 GiB of persisted blocks, whichever comes first. Grafana runtime data, Loki data, Prometheus data, Alloy state, and metric snapshots are disposable operational data: PostgreSQL backups do not include them, and restoring a PostgreSQL backup does not restore them.

From an operator workstation, create the dashboard-only tunnel:

```bash
ssh -N -L 3002:127.0.0.1:3002 <pi-host>
```

Open `http://localhost:3002`, then sign in with the configured Grafana admin credentials. Close the SSH process when finished; doing so removes the workstation's access to Grafana. Do not publish this port or create a Cloudflare route for it.

### Storage guard recovery

The five-minute storage guard stops only Alloy and writes the sentinel when the observability directory reaches `DIALED_OBSERVABILITY_MAX_BYTES` or its filesystem drops below `DIALED_OBSERVABILITY_MIN_FREE_BYTES`. Loki, Prometheus, Grafana, Dialed, PostgreSQL, deployment, and backups remain otherwise independent.

Do not restart Alloy merely to clear this condition. First inspect the recorded reason and both measurements, then correct the underlying capacity problem (for example, free capacity outside the observability directory or make and review a threshold change):

```bash
sudo sh -c '. /etc/dialed/poc.env; cat "$DIALED_OBSERVABILITY_DIR/INGESTION_STOPPED"'
sudo sh -c '. /etc/dialed/poc.env; du -sB1 "$DIALED_OBSERVABILITY_DIR"'
sudo sh -c '. /etc/dialed/poc.env; df -PB1 "$DIALED_OBSERVABILITY_DIR"'
```

After capacity is safe, remove only the exact sentinel and explicitly start Alloy:

```bash
sudo sh -c '. /etc/dialed/poc.env; rm -- "$DIALED_OBSERVABILITY_DIR/INGESTION_STOPPED"'
sudo systemctl start dialed-poc-alloy.service
sudo systemctl status dialed-poc-alloy.service --no-pager
```

Never recursively delete the observability root. If telemetry data must be discarded, stop the affected observability services, identify the precise component data set and recovery consequence, and make that deletion a separate approved data-destruction action.

### Credential changes, upgrades, and journald adoption

To rotate Grafana credentials, use the Grafana profile page while connected through SSH, then use `sudoedit /etc/dialed/poc.env` to keep `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD` consistent with the recovery configuration. Grafana applies the environment password when it initializes its data store; changing the file alone does not reset an existing administrator password. Keep the file `root:root` mode `0600` after editing.

For any Alloy or observability image version change, first review and commit the exact package/image pin, release notes, compatibility impact, and any configuration changes. Update the Pi checkout to that reviewed revision, install the reviewed ARM64 Alloy package if its pin changed, and rerun:

```bash
sudo ops/poc/bin/install
```

The installer deliberately pulls pinned observability images only during a host-assets update; the minute application reconciler does not upgrade them.

Docker applies the POC's `journald` logging driver only when a container is created. After installing this host-assets revision on an existing POC, perform this controlled, brief-restart transition during a maintenance window:

```bash
sudo systemctl stop dialed-poc-deploy.timer
sudo sh -c 'set -a; . /etc/dialed/poc.env; . /var/lib/dialed/active.env; set +a; docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml up -d --force-recreate postgres api web cloudflared'
sudo docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml ps
sudo systemctl enable --now dialed-poc-deploy.timer
```

Do not recreate `migrate` manually; it remains a one-shot deployment service. Confirm the controlled recreation and a subsequent request appear in Grafana/Loki before considering journald adoption complete.

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

Disable the public hostname first. Observability can be removed independently without stopping the Dialed application, database, deploy timer, or backup timer. Stop and disable Alloy and the two observability timers first, then stop the observability Compose owner:

```bash
sudo systemctl disable --now \
  dialed-poc-alloy.service \
  dialed-poc-observe.timer \
  dialed-poc-storage-guard.timer
sudo systemctl stop dialed-poc-observability.service
```

For a full POC teardown, then stop the application timers and Compose stack:

```bash
sudo systemctl disable --now dialed-poc-deploy.timer dialed-poc-backup.timer
sudo sh -c 'set -a; . /etc/dialed/poc.env; . /var/lib/dialed/active.env; set +a; docker compose --env-file /etc/dialed/poc.env -f /opt/dialed/compose.poc.yaml down'
```

Remove the Cloudflare hostname, Access application, service token, and tunnel after the connector is offline. Revoke Google credentials if they are dedicated to the POC.

By default, preserve `/etc/dialed/poc.env`, `/var/lib/dialed` (including deployment state), `DIALED_DATA_DIR` (including PostgreSQL), `DIALED_BACKUP_DIR`, and `DIALED_OBSERVABILITY_DIR`. They contain recovery material or intentionally retained operational history. Any data deletion is a separate, explicit data-destruction decision after verifying off-device backups; this runbook intentionally provides no recursive deletion command for the observability root.

## Raspberry Pi deployment acceptance gate

The repository checks below do not replace an on-Pi acceptance run. Before declaring a deployment complete, record the exact Alloy, Grafana, Loki, and Prometheus versions plus measured steady-state and peak memory in deployment notes, and perform these ten checks on the actual Pi:

1. Run the reviewed installer while observability is stopped and confirm Dialed is left unchanged if observability startup fails.
2. Start the observability stack and confirm Grafana, Loki, Prometheus, and Alloy status is healthy.
3. Open the SSH forward and log into Grafana at `http://localhost:3002`.
4. Make a harmless Dialed request and find its structured request log in Loki.
5. Restart one allowlisted POC container and confirm its running/health/restart metrics update.
6. Run a backup and a forced reconcile; confirm both operation states are represented.
7. Confirm the readiness, temperature, SSD, and active-revision panels show current values.
8. Stop observability and prove Dialed, PostgreSQL, reconciliation, and backups continue independently.
9. Test the storage guard with a safe, temporary reviewed threshold and recover using the sentinel procedure above.
10. Verify port `3002` is closed on the Pi LAN address and reachable only through the SSH forward.

This acceptance gate cannot be completed from a WSL development environment.
