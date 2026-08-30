# Raspberry Pi Observability Design

## Summary

Dialed will gain a local observability stack for its Raspberry Pi proof-of-concept deployment. Grafana will provide one provisioned operational dashboard, Loki will retain searchable logs for fourteen days, Prometheus will retain metrics for thirty days, and a host-native Grafana Alloy service will collect Raspberry Pi metrics and approved journald streams.

The dashboard will not be exposed through Cloudflare or on the Pi's LAN address. Grafana will bind only to the Pi loopback interface and the operator will reach it through an SSH local-forwarding session. Grafana authentication remains enabled as a second access boundary.

Observability is explicitly subordinate to the application. Failure, resource exhaustion, configuration errors, or maintenance in Grafana, Loki, Prometheus, or Alloy must not prevent Dialed from serving traffic, reconciling releases, or creating PostgreSQL backups.

## Goals

- Provide one dashboard for Dialed service health, deployment state, backup state, API activity, PostgreSQL readiness, and Raspberry Pi health.
- Make logs from the API, web process, PostgreSQL, Cloudflare Tunnel, deployment service, and backup service searchable in one place.
- Capture Pi CPU, load, memory, SSD capacity and I/O, network traffic, and hardware temperature.
- Report allowlisted container running state, Docker health state, restart count, and the active Dialed revision without giving a long-running third-party process access to the Docker socket.
- Retain logs for fourteen days and metrics for thirty days.
- Bound Prometheus and journald storage and stop telemetry ingestion before observability can exhaust the SSD.
- Keep all observability endpoints local to the Pi and require SSH plus Grafana credentials for dashboard access.
- Provision data sources and dashboards from repository-owned files so the setup is reproducible.
- Preserve the existing reviewed-host-assets deployment model.

## Non-goals

- Public or Cloudflare-hosted access to Grafana.
- High availability, remote replication, or recovery guarantees for observability data.
- Backing up logs, metrics, Grafana sessions, or ad hoc dashboard edits.
- External notifications, paging, email, or chat alerts in the initial version.
- Distributed tracing or browser telemetry.
- Full PostgreSQL query-performance monitoring.
- A general-purpose Docker monitoring agent with unrestricted daemon access.
- Replacing the existing health endpoints, deployment checks, journald workflow, or PostgreSQL backups.
- Treating observability availability as an application health or deployment gate.

## Existing Constraints

The POC currently runs `web`, `api`, `postgres`, `migrate`, and `cloudflared` in Docker Compose. No service publishes a host port. The API uses Fastify and already emits JSON through Pino in production. Deployment and backup are root-owned systemd one-shot services and log to journald.

The existing deployment design prohibits mounting the Docker socket into application or third-party long-running containers. It also requires application and PostgreSQL data to live on a USB SSD and requires host-level assets to be updated only after reviewing a repository revision and rerunning `sudo ops/poc/bin/install`.

The target remains a 64-bit Raspberry Pi 4 with at least 4 GB of RAM or a Raspberry Pi 5. The design must use ARM64-compatible, version-pinned components and leave enough CPU, memory, I/O capacity, and disk space for Dialed.

## Chosen Approach

Grafana, Loki, and Prometheus will run in a dedicated Compose project. Grafana Alloy will run as a native systemd service on the host. This split gives Alloy direct, narrowly configured access to journald, procfs, sysfs, hardware sensors, and the node-exporter textfile directory without broad host mounts inside a container.

Alternatives considered were an all-container stack and Grafana Cloud. An all-container collector would require broad read-only host mounts and complicated host journal permissions. Grafana Cloud would reduce Pi storage but would move telemetry off the device, introduce an external account and dependency, and no longer make SSH the dashboard access boundary. Neither is preferred for this local POC.

## Topology

The repository will add `compose.observability.yaml` as a Compose project separate from `compose.poc.yaml`.

```text
Browser on operator workstation
    |
    | SSH local forward
    v
Pi 127.0.0.1:3002
    |
    v
Grafana :3000
    |                         host-native Alloy
    |                         |-- journald logs
    |                         |-- procfs/sysfs metrics
    |                         |-- textfile metrics
    |                         |
    |---- queries ------------+----> Loki :3100
    |                         |
    `---- queries ------------+----> Prometheus :9090
```

Grafana will publish container port 3000 as host `127.0.0.1:3002`. Loki and Prometheus will publish their ingestion endpoints only on `127.0.0.1` so host-native Alloy can send data to them. Their Compose services also share a private observability network so Grafana can query them by service name. No observability service will attach to the Dialed application, ingress, or egress networks.

The operator access command is:

```bash
ssh -L 3002:127.0.0.1:3002 <pi-host>
```

The operator then opens `http://localhost:3002` and authenticates to Grafana. HTTP within the tunnel is acceptable because SSH encrypts the workstation-to-Pi path and Grafana listens only on loopback.

## Components

### Grafana

Grafana will use a pinned ARM64-compatible image. It will have a small SSD-backed data directory for its internal database and sessions, but all required data sources, dashboards, and dashboard-provider configuration will come from read-only repository-managed provisioning files.

Anonymous access and user signup will be disabled. The initial admin user and password will be required values in the Pi's root-readable configuration. Grafana will not expose a LAN, ingress-network, or Cloudflare route. Usage reporting, update checks, and externally loaded avatars will be disabled where supported so routine use remains local.

The provisioned Prometheus and Loki data sources will use the private observability network. Grafana is the only intended human interface; direct Prometheus and Loki interfaces remain loopback-only operational endpoints.

### Loki

Loki will run as a single-process instance with the TSDB index and filesystem object store, which is appropriate for a single Pi POC. Its index, chunks, write-ahead data, and compactor working directory will be bind-mounted beneath the dedicated observability SSD path.

Compactor retention will be enabled with a global fourteen-day retention period and a 24-hour index period. Retention marker state will be persistent. Loki's filesystem backend deletes by age rather than total disk usage, so it participates in the separate host storage guard described below.

### Prometheus

Prometheus will store its TSDB beneath the dedicated observability SSD path. It will accept remote writes only from host loopback, because Alloy is the collector. Storage will use thirty-day time retention and a 1 GiB block-retention limit; whichever condition is reached first wins. The remaining disk and free-space guard account for the write-ahead log, head chunks, and temporary compaction overhead that are not a strict part of the block limit.

Prometheus will not scrape the application across the private Dialed network. Application request metrics will initially be derived from structured logs, while host and operational metrics arrive from Alloy.

### Grafana Alloy

Alloy will be installed from Grafana's version-pinned ARM64 Debian package and run under systemd with a repository-managed configuration. The runbook will install the package explicitly; `ops/poc/bin/install` will validate its presence and expected version before installing configuration and overrides.

The service will run under the dedicated Alloy account with only the journal group membership and read paths needed by the selected collectors. Its HTTP diagnostics endpoint will stay on its default loopback binding. The systemd unit or override will set a memory limit, CPU quota, restart policy, filesystem protections, and a lower scheduling priority than the application.

The Alloy pipeline will:

1. Read allowlisted journal streams.
2. Normalize service, stream, severity, environment, and revision fields.
3. Parse the API's Pino JSON while preserving the original message.
4. Send logs to Loki over Pi loopback.
5. Collect a deliberately limited node-exporter metric set from procfs, sysfs, filesystems, networking, hardware monitoring, and thermal zones.
6. Read Dialed operational metrics from a root-owned textfile directory.
7. Send metrics to Prometheus over Pi loopback.

Collectors that provide no value on a Pi or add disproportionate overhead will be disabled. Scraping will default to a thirty-second interval.

### Dialed operational metric producer

A short root-owned one-shot script and systemd timer will produce Prometheus textfile metrics atomically. It will run every thirty seconds and query only the explicitly allowlisted Dialed and observability services.

The producer may call `docker inspect` and `systemctl show`, but Alloy itself will not join the Docker group or access the Docker socket. Metrics will cover:

- Container present and running state.
- Docker health state when a service defines a health check.
- Container restart count.
- Current active Dialed revision from the root-readable active deployment state.
- Deployment and backup service result and completion time.
- Telemetry-ingestion guard state.

The textfile directory will be owned by `root:alloy` with mode `0750`, and completed metric files will be group-readable with mode `0640`. The script will write a temporary textfile and atomically rename it only after generating a complete, valid metric set. Failure will leave the last complete file in place and log an error to journald. Labels will use a fixed service allowlist and will never contain container IDs, paths, error messages, user data, or other unbounded values.

Deployment and backup scripts will write precise result, revision, and timestamp state for the metric producer when the textfile handoff directory is present. These writes are best-effort: a missing observability directory or write failure must not change a deployment or backup exit status.

## Log Collection

The POC Compose services will use Docker's journald logging driver. Compose will attach stable service and revision metadata that Alloy can read from the journal. Recreating a container after the host-assets update applies the driver change; the runbook will make this transition explicit.

Alloy will allowlist:

- `web`, `api`, `postgres`, and `cloudflared` container streams.
- The one-shot `migrate` stream when present.
- Dialed deployment, backup, operational-metric, and storage-guard systemd units.
- Warning and error records from Grafana, Loki, Prometheus, and Alloy.

Restricting observability-component ingestion to warning and error avoids noisy recursive telemetry caused by recording routine ingestion requests. Full component logs remain available through `journalctl` on the Pi.

The API logger will use an explicit production configuration rather than `logger: true`. It will include service, revision, request ID, HTTP method, normalized route, status code, response time, severity, and error stack when appropriate. It will redact authorization, cookie, set-cookie, OAuth, and other secret-bearing header paths. It will not log request or response bodies, database URLs, tokens, email addresses, account IDs, or sync payloads.

Loki labels will be restricted to stable, low-cardinality dimensions such as environment, service, stream, severity, and revision. Request IDs, raw URLs, container IDs, error strings, and user-associated values remain parsed or raw log fields rather than labels. URL labels will use Fastify route templates rather than user-controlled paths.

PostgreSQL statement logging will not be enabled. This prevents synchronized account data or secrets from entering the log pipeline.

## Metrics

Host metrics will include:

- CPU utilization, frequency, load, and pressure.
- Memory and swap utilization.
- SSD free space, inode use, and I/O.
- Network bytes, errors, and interface state, excluding transient container interfaces.
- Uptime and time synchronization indicators where available.
- Thermal-zone and hardware-monitor temperatures exposed by the Pi kernel.

Application and operational metrics will include:

- Running, healthy, and restart counts for the fixed service set.
- API request count, response-status classes, and response-time distributions derived in Grafana from Loki logs.
- API and PostgreSQL readiness through Docker health state.
- Active application revision.
- Last meaningful deployment and backup results and timestamps.
- Alloy, Loki, and Prometheus scrape/ingestion health.

This version will not add a Prometheus client library or `/metrics` endpoint to the API. Structured Fastify logs and existing health checks meet the initial dashboard requirements without expanding the application's public interface. Application-native metrics can be considered later if log-derived queries prove insufficient.

## Dashboard

The repository will provision one `Dialed POC Overview` dashboard and make it Grafana's home dashboard. It will include:

1. **Release and service summary**: active revision, Pi uptime, service running/health state, restart counts, last deployment, and last backup.
2. **Host capacity**: CPU, load, memory, SSD utilization and I/O, network traffic, and Pi temperature with warning thresholds.
3. **Application activity**: API request rate, response-time percentiles available from log-derived samples, status-class distribution, and recent server errors.
4. **Data and ingress health**: PostgreSQL readiness, API readiness, Cloudflare connector state, Prometheus targets, and Loki ingestion freshness.
5. **Logs**: a service/severity/revision-filtered Loki panel plus links into Grafana Explore.

Dashboard thresholds will visually identify unhealthy services, recent restarts, failed deployment or backup operations, elevated API errors, high temperature, high memory, and low SSD space. This is not an alerting contract; no external notification channel will be configured initially.

## Storage and Retention

The root-readable Pi configuration will add values for:

- `DIALED_OBSERVABILITY_DIR`, an absolute dedicated SSD-backed child path separate from PostgreSQL and backups.
- `GRAFANA_ADMIN_USER` and `GRAFANA_ADMIN_PASSWORD`.
- `DIALED_OBSERVABILITY_MAX_BYTES`, defaulting to 5 GiB.
- `DIALED_OBSERVABILITY_MIN_FREE_BYTES`, defaulting to 10 GiB.

The installer will validate that the observability path is absolute, dedicated, root-owned, non-symlinked, mode `0700`, and does not contain or sit within either existing live-data path. Component child directories will receive only the ownership and permissions their container identities require.

Storage controls are layered:

- Loki deletes logs older than fourteen days through its compactor.
- Prometheus deletes blocks older than thirty days or beyond 1 GiB, whichever happens first.
- Journald will be bounded with a 512 MiB persistent maximum and a smaller runtime maximum through a reviewed drop-in, while respecting whether the host uses persistent or volatile journals.
- Compose will apply resource-appropriate log rate and service limits where supported.
- A root-owned storage guard runs every five minutes and checks both total observability directory bytes and remaining bytes on the containing filesystem.

If the observability directory reaches its configured maximum or the filesystem falls below its reserve, the guard will stop Alloy to halt new ingestion, create a root-owned sentinel containing the reason and timestamp, and log a high-severity journald record. It will not delete Loki or Prometheus files, stop Dialed, stop PostgreSQL, or change backup/deployment results.

The free-space reserve must be comfortably larger than expected Prometheus compaction overhead and the five-minute guard interval's possible ingestion. The operator must inspect the cause, free space or adjust a reviewed threshold, remove the sentinel, and restart Alloy explicitly. The runbook will document this recovery. Existing data remains queryable while Alloy is stopped.

Logs and metrics are disposable operational data. PostgreSQL backup jobs will not include the observability directory. Provisioned configuration is recovered from the repository; runtime telemetry loss is accepted.

## Resource Controls

Grafana, Loki, and Prometheus will have Compose memory and CPU limits rather than unrestricted access to the Pi. The initial ceilings will be 512 MiB and one CPU for Grafana, 512 MiB and one CPU for Loki, and 384 MiB and one CPU for Prometheus. Alloy will use a 256 MiB systemd `MemoryMax` and a 50 percent `CPUQuota`. These are ceilings rather than reservations and limit the observability stack to at most 1.625 GiB of memory on the minimum supported 4 GB Pi. Implementation may lower a ceiling after measured Raspberry Pi acceptance, but raising one requires an explicit design update.

The limits will favor Dialed under contention. An out-of-memory restart or dropped telemetry is preferable to application, database, or tunnel disruption. Restart policies will cover each long-running observability component, and the host operational probe will check each component's documented readiness endpoint. No Dialed service will depend on their health.

High-cardinality labels, unnecessary collectors, sub-thirty-second scrape intervals, and verbose component logs are prohibited by the initial configuration because they multiply Pi CPU, memory, and storage use.

## Security

- All published ports use explicit `127.0.0.1` host bindings.
- No Cloudflare route or application-network attachment is created for observability.
- Grafana anonymous access and signup are disabled.
- Grafana credentials stay in the existing root-owned, mode `0600` Pi configuration contract and are never committed.
- Loki and Prometheus have no LAN or Internet listener.
- Alloy keeps its diagnostics endpoint on loopback.
- Alloy receives no Docker socket and is not a member of the Docker group.
- The Docker-aware metric producer is a short root-owned one-shot unit with a fixed allowlist, protected filesystem settings, and no network requirement.
- Repository-managed configuration mounts are read-only.
- Long-running containers run without new privileges and with capabilities dropped unless a documented component requirement proves otherwise.
- Application logging excludes or redacts credentials and user-associated content before collection.
- Image versions and the Alloy package version are pinned and updated through reviewed host-asset changes.

Anyone with membership in the Docker group or root access can already read container environment values and modify the host. Grafana's second login boundary protects against accidental access through an existing SSH session; it is not intended to defend against a compromised Pi administrator.

## Failure Behavior

- If Alloy is unavailable, Dialed continues and source records remain in the bounded journal until rotated. Telemetry may be lost after rotation.
- If Loki is unavailable, Alloy retries only within bounded resources; it must not create an unbounded disk queue.
- If Prometheus is unavailable, current samples may be lost; Alloy must not consume unbounded memory or disk.
- If Grafana is unavailable, collection and storage continue.
- If the metric producer fails, the last atomic metric file remains and its age makes staleness visible.
- If retention configuration is invalid, the affected observability service fails its own health check without affecting Dialed.
- If the storage guard trips, only new Alloy ingestion stops. Existing telemetry services and Dialed remain available.
- If the observability Compose stack cannot start after an installer update, the installer reports the failure but does not tear down or restart the Dialed application stack.
- If the host reboots, systemd starts storage services before Alloy so Alloy does not immediately send to unavailable endpoints.

## Installation and Operations

The existing POC installer remains the entry point. After validating the new configuration and Alloy dependency it will:

1. Create the dedicated observability directory structure with least-privilege ownership.
2. Install the observability Compose file and Grafana, Loki, Prometheus, Alloy, and dashboard configuration under `/opt/dialed`.
3. Install the operational metric producer, storage guard, and their systemd units.
4. Install the bounded journald drop-in and reload journald safely.
5. Validate rendered Compose, Alloy, Loki, Prometheus, and dashboard configuration before replacing running host assets.
6. Reload systemd and start the observability stack, metric timer, storage guard timer, and Alloy in dependency order.

Normal application reconciliation will continue to recreate only application services. It will not pull, restart, or roll back observability services. Updating observability images, configuration, dashboards, systemd units, or Alloy requires updating the Pi checkout to a reviewed revision and rerunning `sudo ops/poc/bin/install`, matching the existing host-assets policy.

The runbook will document:

- Installing the pinned Alloy package on ARM64 Raspberry Pi OS.
- Adding and validating the observability configuration values.
- Starting, stopping, and inspecting each component.
- Opening and closing the SSH local forward.
- Grafana first login and admin-password rotation.
- Querying logs and interpreting dashboard panels.
- Investigating stale telemetry or service health.
- Recovering from the storage-guard sentinel.
- Recreating disposable observability data without touching PostgreSQL or backups.
- Removing observability while preserving Dialed.

## Testing Strategy

### Static and configuration tests

- Render `compose.observability.yaml` with fixture values and require pinned images, resource limits, restart policies, expected mounts, documented readiness endpoints, and only explicit loopback port bindings.
- Assert that observability services are absent from the POC application, ingress, and egress networks.
- Validate Loki and Prometheus configuration with their supported configuration-check commands.
- Validate Alloy configuration with its supported configuration-check command.
- Parse Grafana provisioning YAML and dashboard JSON and verify data-source identifiers and required panels.
- Verify the POC Compose services use the intended journald configuration and stable metadata.

### Unit tests

- Exercise the operational metric producer against fake Docker, systemd, active-state, and filesystem commands.
- Verify missing containers, unhealthy containers, restarts, failed units, malformed state, and stale output behavior.
- Verify all textfile writes are atomic and metric names, labels, and values are valid and bounded.
- Exercise the storage guard below each threshold, at each threshold, and above each threshold.
- Verify the guard stops only Alloy, writes its sentinel atomically, and never issues application, database, deletion, or backup commands.
- Verify deployment and backup telemetry writes are best-effort and cannot alter the parent operation's result.
- Test production Fastify logger configuration and redaction without asserting secrets into test failure output.

### Regression tests

- Run existing formatting, lint, type checking, unit, ops, build, database integration, and browser suites.
- Confirm the application health, backup, reconcile, rollback, and teardown workflows remain independent of observability.
- Confirm rendering the POC Compose model still publishes no application port.

### Raspberry Pi acceptance

1. Install with the observability stack stopped and confirm Dialed remains healthy.
2. Start observability and verify all component health checks.
3. Open the SSH forward, authenticate to Grafana, and load the provisioned dashboard.
4. Exercise an API request and confirm its structured log and derived request metric appear without sensitive fields.
5. Restart an allowlisted container and confirm state and restart count change.
6. Run a manual backup and deployment reconciliation and confirm their outcomes and timestamps appear.
7. Verify PostgreSQL/API readiness, Pi temperature, SSD metrics, and active revision.
8. Stop Alloy and then the entire observability Compose stack and confirm Dialed health and deployment behavior are unchanged.
9. Exercise the storage guard with a safe test threshold and confirm it stops only Alloy and creates the sentinel.
10. Close the SSH session and confirm port 3002 is unreachable from another LAN host.

## Operational Files

Implementation is expected to add or update these file groups:

- `compose.observability.yaml` for Grafana, Loki, and Prometheus.
- `ops/poc/observability/` for Alloy, Loki, Prometheus, Grafana provisioning, and dashboard configuration.
- `ops/poc/bin/` for the operational metric producer and storage guard.
- `ops/poc/systemd/` for the new service, timer, and Alloy override units.
- `ops/poc/poc.env.example` for value-free observability settings.
- `ops/poc/bin/install` for validation and installation.
- `compose.poc.yaml` for journald logging metadata.
- `apps/api/src/` for explicit structured logger configuration and redaction.
- `ops/poc/test/` and API tests for the new behavior.
- `ops/poc/README.md` and the root `README.md` for installation and access guidance.

Exact file boundaries may be refined in the implementation plan, but the separation between application Compose, observability Compose, repository-managed configuration, and root-owned one-shot host probes is part of this approved design.

## Rollout Sequence

1. Add API logger configuration and tests.
2. Add observability configuration, provisioning, dashboard, and static validation.
3. Add the Docker/systemd metric producer and tests.
4. Add the storage guard and tests.
5. Extend the installer and environment contract without changing the running Pi.
6. Update the POC logging driver and operational scripts.
7. Run the complete local and CI verification suite.
8. Review and update the Pi checkout.
9. Install the pinned Alloy ARM64 package.
10. Add the new root-readable environment values and rerun the installer.
11. Verify the local stack and SSH-only access before relying on the dashboard.
12. Recreate the POC application services during a controlled window so journald collection applies.
13. Perform the Raspberry Pi acceptance checks.

## Success Criteria

The work is complete when the operator can establish an SSH local forward, authenticate to the provisioned Grafana instance, and use one dashboard to see Pi capacity and temperature, Dialed and PostgreSQL health, the active revision, container restarts, deployment and backup results, API activity, and searchable service logs for the agreed retention windows.

No observability endpoint may be reachable over the LAN, Cloudflare, or the public Internet. No long-running observability process may access the Docker socket. Sensitive application data must not enter the intended log schema. Stopping or exhausting the observability stack must leave Dialed serving, deploying, and backing up normally.
