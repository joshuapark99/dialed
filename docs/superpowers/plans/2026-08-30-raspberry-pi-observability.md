# Raspberry Pi Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SSH-only Grafana dashboard, fourteen-day searchable logs, and thirty-day Raspberry Pi and Dialed operational metrics without weakening the existing POC deployment boundary.

**Architecture:** Run version-pinned Grafana, Loki, and Prometheus services in a separate loopback-only Compose project, and run Grafana Alloy as a constrained host systemd service that reads journald and Pi metrics. Short root-owned one-shot scripts expose allowlisted Docker/systemd state and stop Alloy ingestion at storage limits; application deploy, backup, and availability never depend on observability.

**Tech Stack:** Docker Compose v2.24+, Grafana 13.1.3, Loki 3.7.6, Prometheus 3.13.2 LTS, Grafana Alloy 1.19.0, systemd/journald, POSIX shell, Fastify/Pino, Node.js 22/24 `node:test`, Grafana provisioning JSON/YAML.

**Spec:** `docs/superpowers/specs/2026-08-30-raspberry-pi-observability-design.md`

## Global Constraints

- Target only 64-bit Raspberry Pi OS on `aarch64`; retain the existing Pi 4 with 4 GB RAM or Pi 5 minimum.
- Bind Grafana to `127.0.0.1:3002`, Loki to `127.0.0.1:3100`, Prometheus to `127.0.0.1:9090`, and Alloy diagnostics to `127.0.0.1:12345`; never add a LAN, application-network, ingress-network, or Cloudflare observability route.
- Pin `grafana/grafana:13.1.3`, `grafana/loki:3.7.6`, `prom/prometheus:v3.13.2`, and the `alloy=1.19.0-1` ARM64 Debian package. Do not use `latest`, floating major/minor tags, or `grafana/grafana-oss`.
- Retain Loki data for `336h`; retain Prometheus data for `30d` and at most `1GB` of persistent blocks.
- Default total observability usage to 5 GiB and minimum free SSD space to 10 GiB; stop only Alloy when either guard trips and never delete telemetry files behind a storage engine.
- Cap Grafana at 512 MiB/1 CPU, Loki at 512 MiB/1 CPU, Prometheus at 384 MiB/1 CPU, and Alloy at 256 MiB/50 percent CPU.
- Never give Grafana, Loki, Prometheus, or Alloy the Docker socket or Docker-group membership. Only the short root-owned metric snapshot unit may query Docker, using a fixed service allowlist.
- Do not add API `/metrics`, distributed tracing, browser telemetry, external alerts, PostgreSQL statement logging, or telemetry backups.
- Keep labels low-cardinality: `environment`, `service`, `stream`, `level`, `revision`, fixed operation names, and fixed health states only. Never label by raw URL, request ID, container ID, user/account value, path, or error text.
- All deployment/backup observability writes are best-effort and must preserve the parent operation's exit status.
- Application deployment, rollback, health, backup, and teardown behavior must remain independent from observability health.

## File Map

### Application logging

- Create `apps/api/src/logger.ts`: production Pino options and the explicit completion-log field contract.
- Create `apps/api/test/logger.test.ts`: JSON-field, normalized-route, and secret-redaction tests.
- Modify `apps/api/src/server.ts`: accept typed logger options, suppress Fastify's default request logs, emit one normalized completion record, and attach request context to errors.
- Modify `apps/api/src/main.ts`: use the production logger factory with `APP_REVISION`.

### Local storage and dashboard

- Create `compose.observability.yaml`: isolated Grafana/Loki/Prometheus project.
- Create `ops/poc/observability/loki.yaml`: single-process TSDB/filesystem Loki with compactor retention.
- Create `ops/poc/observability/prometheus.yaml`: remote-write receiver, self/component scrapes, and TSDB retention.
- Create `ops/poc/observability/grafana/provisioning/datasources/dialed.yaml`: fixed Prometheus/Loki data-source UIDs.
- Create `ops/poc/observability/grafana/provisioning/dashboards/dialed.yaml`: file dashboard provider.
- Create `ops/poc/observability/grafana/dashboards/dialed-poc-overview.json`: repository-managed home dashboard.
- Create `ops/poc/test/fixtures/observability.env`: non-secret Compose fixture values.
- Create `ops/poc/test/observability-compose.test.mjs`: topology, pin, retention, mount, and configuration contracts.
- Create `ops/poc/test/grafana.test.mjs`: provisioning and dashboard query contracts.

### Host collection and operational metrics

- Create `ops/poc/observability/alloy/config.alloy`: allowlisted journald, Pino parsing, host/textfile metrics, and bounded writes.
- Create `ops/poc/systemd/dialed-poc-alloy.service`: constrained host Alloy unit.
- Create `ops/poc/test/alloy.test.mjs`: config contents, validation, and unit constraints.
- Create `ops/poc/bin/observe`: atomic Prometheus textfile snapshot for fixed Docker/systemd/readiness targets.
- Create `ops/poc/bin/record-operation`: atomic best-effort deployment/backup event state.
- Create `ops/poc/systemd/dialed-poc-observe.service` and `.timer`: thirty-second root snapshot.
- Create `ops/poc/test/observe.test.mjs`: allowlist, state, atomicity, and stale-output tests.
- Modify `ops/poc/bin/backup` and `ops/poc/bin/reconcile`: record meaningful outcomes without affecting exit status.
- Modify `ops/poc/test/backup.test.mjs` and `ops/poc/test/reconcile.test.mjs`: outcome-state regression coverage.

### Storage and lifecycle

- Create `ops/poc/bin/storage-guard`: byte-safe threshold check that stops only Alloy and writes a sentinel.
- Create `ops/poc/systemd/dialed-poc-storage-guard.service` and `.timer`: five-minute protection schedule.
- Create `ops/poc/test/storage-guard.test.mjs`: below/at/above threshold and failure-boundary tests.
- Create `ops/poc/bin/observability`: root-owned Compose lifecycle wrapper.
- Create `ops/poc/systemd/dialed-poc-observability.service`: boot/start/stop ordering for the storage services.
- Create `ops/poc/observability/journald/90-dialed-poc.conf`: bounded persistent/runtime journal use.
- Modify `ops/poc/bin/install`: dependency, version, secret, storage, ownership, config, and unit installation.
- Modify `ops/poc/poc.env.example` and `ops/poc/test/fixtures/poc.env`: observability configuration contract.
- Modify `ops/poc/test/systemd.test.mjs`: all new service/timer hardening and ordering contracts.
- Modify `compose.poc.yaml` and `ops/poc/test/compose.test.mjs`: journald routing and stable revision/service metadata.

### Documentation

- Modify `ops/poc/README.md`: bootstrap, SSH access, operation, guard recovery, update, and teardown instructions.
- Modify `README.md`: point to the local dashboard workflow.

---

### Task 1: Structured and privacy-safe API request logs

**Files:**

- Create: `apps/api/src/logger.ts`
- Create: `apps/api/test/logger.test.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/main.ts`

**Interfaces:**

- Produces: `createProductionLoggerOptions(revision: string): FastifyServerOptions["logger"]`.
- Produces one `request completed` JSON record with `service`, `revision`, `requestId`, `method`, `route`, `statusCode`, and `responseTime`.
- `ServerDependencies.logger` changes from `boolean` to `FastifyServerOptions["logger"]`; existing omitted/`false` test behavior remains valid.

- [ ] **Step 1: Write failing logger tests**

Add tests that create the server with an in-memory writable stream, inject a request containing a query string and secret headers, and parse each output line as JSON:

```ts
const completed = records.find((record) => record.msg === "request completed");
assert.equal(completed.service, "api");
assert.equal(completed.revision, revision);
assert.equal(completed.method, "GET");
assert.equal(completed.route, "/v1/me");
assert.equal(completed.statusCode, 401);
assert.equal(typeof completed.responseTime, "number");
assert.doesNotMatch(serialized, /session-secret|bearer-secret/);
assert.doesNotMatch(completed.route, /\?|cursor|session-secret/);
```

Also call `app.log.info` with nested `req.headers.authorization`, `req.headers.cookie`, and `res.headers["set-cookie"]` fields and assert each emitted value is `[Redacted]`.

- [ ] **Step 2: Run the logger tests and verify RED**

Run:

```bash
pnpm --filter @dialed/api exec node --import tsx --test test/logger.test.ts
```

Expected: FAIL because `createProductionLoggerOptions` does not exist and completion records do not use the new contract.

- [ ] **Step 3: Add the production logger factory**

Implement `apps/api/src/logger.ts` with this public shape and redaction set:

```ts
import type { FastifyServerOptions } from "fastify";

export function createProductionLoggerOptions(
  revision: string,
): FastifyServerOptions["logger"] {
  return {
    level: "info",
    base: { service: "api", revision },
    redact: {
      censor: "[Redacted]",
      paths: [
        "req.headers.authorization",
        "req.headers.cookie",
        "res.headers.set-cookie",
        'res.headers["set-cookie"]',
        "authorization",
        "cookie",
        "setCookie",
      ],
    },
  };
}
```

Do not add Pino as a direct dependency; Fastify owns the logger implementation.

- [ ] **Step 4: Emit one normalized request-completion log**

In `createServer`, pass `disableRequestLogging: Boolean(dependencies.logger)` and register an `onResponse` hook:

```ts
app.addHook("onResponse", async (request, reply) => {
  request.log.info(
    {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      responseTime: reply.elapsedTime,
    },
    "request completed",
  );
});
```

Use `request.log.error({ err: error, route: request.routeOptions.url }, "request failed")` in the error handler. Never log `request.url`, request bodies, response bodies, principal/account values, or headers.

- [ ] **Step 5: Wire the production factory into startup**

Replace `logger: true` in `apps/api/src/main.ts` with:

```ts
logger: createProductionLoggerOptions(config.APP_REVISION),
```

Import the factory from `./logger.js`.

- [ ] **Step 6: Run API verification and verify GREEN**

Run:

```bash
pnpm --filter @dialed/api test
pnpm --filter @dialed/api typecheck
```

Expected: all API tests pass and TypeScript exits 0.

- [ ] **Step 7: Commit the logging slice**

```bash
git add apps/api/src/logger.ts apps/api/src/server.ts apps/api/src/main.ts apps/api/test/logger.test.ts
git commit -m "feat(api): add structured production request logs"
```

### Task 2: Isolated Loki and Prometheus storage services

**Files:**

- Create: `compose.observability.yaml`
- Create: `ops/poc/observability/loki.yaml`
- Create: `ops/poc/observability/prometheus.yaml`
- Create: `ops/poc/test/fixtures/observability.env`
- Create: `ops/poc/test/observability-compose.test.mjs`

**Interfaces:**

- Produces loopback ingestion URLs `http://127.0.0.1:3100/loki/api/v1/push` and `http://127.0.0.1:9090/api/v1/write` for Task 4.
- Produces internal query URLs `http://loki:3100` and `http://prometheus:9090` for Task 3.
- Consumes `DIALED_OBSERVABILITY_DIR`, `GRAFANA_ADMIN_USER`, and `GRAFANA_ADMIN_PASSWORD` from the env contract completed in Task 7.

- [ ] **Step 1: Write failing topology and retention tests**

Create tests that render `compose.observability.yaml` with `docker compose config --format json` and assert:

```js
assert.equal(model.services.grafana.image, "grafana/grafana:13.1.3");
assert.equal(model.services.loki.image, "grafana/loki:3.7.6");
assert.equal(model.services.prometheus.image, "prom/prometheus:v3.13.2");
assert.deepEqual(model.services.grafana.ports[0].host_ip, "127.0.0.1");
assert.equal(model.services.grafana.ports[0].published, "3002");
assert.equal(model.services.loki.ports[0].host_ip, "127.0.0.1");
assert.equal(model.services.prometheus.ports[0].host_ip, "127.0.0.1");
```

Assert each service uses only the `observability` network, has `restart: unless-stopped`, drops all capabilities, uses `no-new-privileges`, has the exact memory/CPU ceilings, and has no `docker.sock` mount. Read the YAML configs as text and assert `retention_period: 336h`, `period: 24h`, `retention_enabled: true`, `time: 30d`, and `size: 1GB`.

- [ ] **Step 2: Run the new ops test and verify RED**

Run:

```bash
node --test ops/poc/test/observability-compose.test.mjs
```

Expected: FAIL because the Compose and storage configuration files do not exist.

- [ ] **Step 3: Add single-node Loki configuration**

Create a Loki v13 TSDB/filesystem configuration with these exact storage controls:

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  path_prefix: /loki
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules

schema_config:
  configs:
    - from: "2026-01-01"
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

storage_config:
  tsdb_shipper:
    active_index_directory: /loki/index
    cache_location: /loki/cache

compactor:
  working_directory: /loki/compactor
  retention_enabled: true
  delete_request_store: filesystem

limits_config:
  retention_period: 336h
  ingestion_rate_mb: 2
  ingestion_burst_size_mb: 4
```

Keep Loki single-tenant and do not enable its unauthenticated delete API.

- [ ] **Step 4: Add Prometheus configuration**

Enable 30-second collection of storage-component metrics and configure retention in YAML:

```yaml
global:
  scrape_interval: 30s
  evaluation_interval: 30s

storage:
  tsdb:
    retention:
      time: 30d
      size: 1GB

scrape_configs:
  - job_name: prometheus
    static_configs:
      - targets: ["127.0.0.1:9090"]
  - job_name: loki
    static_configs:
      - targets: ["loki:3100"]
  - job_name: grafana
    static_configs:
      - targets: ["grafana:3000"]
```

Prometheus must start with `--web.enable-remote-write-receiver` and may not enable its admin API.

- [ ] **Step 5: Add the observability Compose project**

Define `name: dialed-observability` and only one private bridge network. Use read-only configuration bind mounts and SSD-backed data bind mounts under `${DIALED_OBSERVABILITY_DIR}`. Publish only:

```yaml
ports:
  - "127.0.0.1:3002:3000" # Grafana
  - "127.0.0.1:3100:3100" # Loki, on the Loki service only
  - "127.0.0.1:9090:9090" # Prometheus, on the Prometheus service only
```

Run Grafana as UID/GID `472`, Loki as `10001:10001`, and Prometheus with its pinned image's default `nobody` identity. Add read-only roots and explicit tmpfs paths only after verifying each image's writable-path needs. Grafana must set anonymous access/sign-up/reporting/update/avatar settings off and read its initial admin values from required Compose variables.

- [ ] **Step 6: Validate all storage configuration and verify GREEN**

Run:

```bash
node --test ops/poc/test/observability-compose.test.mjs
docker run --rm -v "$PWD/ops/poc/observability/loki.yaml:/etc/loki/config.yaml:ro" grafana/loki:3.7.6 -config.file=/etc/loki/config.yaml -verify-config=true
docker run --rm --entrypoint promtool -v "$PWD/ops/poc/observability/prometheus.yaml:/etc/prometheus/prometheus.yml:ro" prom/prometheus:v3.13.2 check config /etc/prometheus/prometheus.yml
```

Expected: test passes, Loki exits 0 after configuration verification, and `promtool` reports `SUCCESS`.

- [ ] **Step 7: Commit the storage slice**

```bash
git add compose.observability.yaml ops/poc/observability/loki.yaml ops/poc/observability/prometheus.yaml ops/poc/test/fixtures/observability.env ops/poc/test/observability-compose.test.mjs
git commit -m "feat(ops): add local observability storage"
```

### Task 3: Provisioned Grafana dashboard

**Files:**

- Create: `ops/poc/observability/grafana/provisioning/datasources/dialed.yaml`
- Create: `ops/poc/observability/grafana/provisioning/dashboards/dialed.yaml`
- Create: `ops/poc/observability/grafana/dashboards/dialed-poc-overview.json`
- Create: `ops/poc/test/grafana.test.mjs`
- Modify: `compose.observability.yaml`

**Interfaces:**

- Consumes internal data-source URLs from Task 2.
- Produces immutable data-source UIDs `dialed-prometheus` and `dialed-loki` and dashboard UID `dialed-poc-overview` used by tests and documentation.

- [ ] **Step 1: Write failing Grafana provisioning tests**

Parse the dashboard JSON and provisioning YAML as text/JSON. Require the fixed UIDs, `editable: false`, `allowUiUpdates: false`, no alert definitions, a 30-second refresh, and panel titles for:

```js
const requiredPanels = [
  "Active revision",
  "Service health",
  "Container restarts",
  "Last deployment",
  "Last backup",
  "CPU usage",
  "Memory usage",
  "SSD usage",
  "Disk I/O",
  "Network traffic",
  "Pi temperature",
  "API request rate",
  "API p95 response time",
  "API status classes",
  "Recent errors",
  "Dialed logs",
];
```

Assert the JSON contains neither `alert` nor public URLs and contains both data-source UIDs.

- [ ] **Step 2: Run the Grafana test and verify RED**

Run:

```bash
node --test ops/poc/test/grafana.test.mjs
```

Expected: FAIL because provisioning and dashboard files do not exist.

- [ ] **Step 3: Provision fixed data sources and the dashboard provider**

Create Prometheus and Loki data sources with `access: proxy`, `isDefault: true` only for Prometheus, and these URLs:

```yaml
url: http://prometheus:9090
uid: dialed-prometheus
```

```yaml
url: http://loki:3100
uid: dialed-loki
```

Provision dashboards from `/var/lib/grafana/dashboards`, disable UI persistence, and set the dashboard as home with `GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH`.

- [ ] **Step 4: Build the dashboard JSON with exact core queries**

Use PromQL panels based on:

```text
100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
100 * (1 - node_filesystem_avail_bytes / node_filesystem_size_bytes)
max(node_hwmon_temp_celsius) or max(node_thermal_zone_temp)
dialed_container_running
dialed_container_health_status
dialed_container_restart_count
dialed_active_revision_info
dialed_operation_last_timestamp_seconds
dialed_observability_endpoint_up
```

Use LogQL panels based on:

```text
sum(rate({service="api"} | json | msg="request completed" [5m]))
quantile_over_time(0.95, {service="api"} | json | msg="request completed" | unwrap responseTime [5m])
sum by (statusCode) (count_over_time({service="api"} | json | msg="request completed" [5m]))
{environment="poc", service=~"$service", level=~"$level"}
```

Add fixed-value dashboard variables for the bounded `service`, `level`, and `revision` labels. Set warning thresholds at 80 percent memory/disk, 75 °C temperature, any unhealthy state, any failed operation, and any API 5xx record.

- [ ] **Step 5: Mount provisioning read-only and verify GREEN**

Mount only the provisioning and dashboard directories into Grafana, then run:

```bash
node --test ops/poc/test/grafana.test.mjs ops/poc/test/observability-compose.test.mjs
pnpm exec prettier --check ops/poc/observability/grafana ops/poc/test/grafana.test.mjs
```

Expected: both tests pass and Prettier reports all files formatted.

- [ ] **Step 6: Commit the dashboard slice**

```bash
git add compose.observability.yaml ops/poc/observability/grafana ops/poc/test/grafana.test.mjs
git commit -m "feat(ops): provision Dialed Grafana dashboard"
```

### Task 4: Host Alloy collection pipeline

**Files:**

- Create: `ops/poc/observability/alloy/config.alloy`
- Create: `ops/poc/systemd/dialed-poc-alloy.service`
- Create: `ops/poc/test/alloy.test.mjs`
- Modify: `ops/poc/test/systemd.test.mjs`

**Interfaces:**

- Consumes the Loki/Prometheus loopback endpoints from Task 2 and `/var/lib/dialed/observability/textfile/*.prom` from Task 5.
- Produces host/node metrics and journal streams labeled with `environment="poc"`.
- Produces a local diagnostic endpoint at `127.0.0.1:12345`.

- [ ] **Step 1: Write failing Alloy and systemd tests**

Require the config to contain `loki.source.journal`, `loki.relabel`, `loki.process`, `loki.write`, `prometheus.exporter.unix`, `prometheus.scrape`, and `prometheus.remote_write`. Assert the Docker socket and `discovery.docker` are absent. Extend the unit parser to require:

```js
assert.equal(value(alloy, "Service", "User"), "alloy");
assert.equal(value(alloy, "Service", "MemoryMax"), "256M");
assert.equal(value(alloy, "Service", "CPUQuota"), "50%");
assert.equal(value(alloy, "Service", "Restart"), "on-failure");
assert.match(value(alloy, "Service", "ExecStart"), /127\.0\.0\.1:12345/);
assert.doesNotMatch(
  readUnit("dialed-poc-alloy.service"),
  /docker\.sock|SupplementaryGroups=docker/,
);
```

- [ ] **Step 2: Run Alloy tests and verify RED**

Run:

```bash
node --test ops/poc/test/alloy.test.mjs ops/poc/test/systemd.test.mjs
```

Expected: FAIL because the Alloy config and unit do not exist.

- [ ] **Step 3: Configure journal filtering and Pino parsing**

Read the journal with `format_as_json = false`, copy `__journal__systemd_unit`, `__journal_container_name`, and `__journal_priority_keyword` into stable labels, then keep only names matching the fixed Dialed/observability allowlist. The relabel keep expression must cover `dialed-poc-(api|web|postgres|migrate|cloudflared)-1`, `dialed-observability-(grafana|loki|prometheus)-1`, and `dialed-poc-(deploy|backup|observe|storage-guard|alloy).service`.

Use `loki.process` JSON extraction for `level`, `requestId`, `method`, `route`, `statusCode`, `responseTime`, `revision`, and `msg`. Promote only `level`, `service`, `environment`, and `revision` to labels. Drop info/debug messages from `grafana`, `loki`, `prometheus`, and `alloy`; retain their warning/error records. Write to:

```alloy
loki.write "local" {
  endpoint {
    url = "http://127.0.0.1:3100/loki/api/v1/push"
  }
}
```

Do not configure a disk-backed client queue.

- [ ] **Step 4: Configure bounded Pi and textfile metrics**

Use `prometheus.exporter.unix` with the collectors `cpu`, `cpufreq`, `diskstats`, `filesystem`, `hwmon`, `loadavg`, `meminfo`, `netclass`, `netdev`, `pressure`, `stat`, `thermal_zone`, `time`, and `timex`. Exclude pseudo filesystems, Docker overlay mounts, and transient `veth` interfaces. Configure its textfile collector for `/var/lib/dialed/observability/textfile`.

Scrape every 30 seconds and remote-write through a bounded queue:

```alloy
prometheus.remote_write "local" {
  endpoint {
    url = "http://127.0.0.1:9090/api/v1/write"
    queue_config {
      capacity             = 500
      max_shards           = 1
      min_shards           = 1
      max_samples_per_send = 250
    }
  }
}
```

Include Alloy's own metrics without enabling clustering or remote configuration.

- [ ] **Step 5: Add the hardened Alloy systemd service**

Run `/usr/bin/alloy run` as `alloy:alloy` with supplementary `adm` and `systemd-journal` groups, `--server.http.listen-addr=127.0.0.1:12345`, `--storage.path=/var/lib/dialed/observability/alloy`, and the installed config path. Add `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectHome=true`, `ProtectSystem=strict`, explicit read/write paths, `MemoryMax=256M`, `CPUQuota=50%`, `Nice=5`, and `Restart=on-failure`. Order it after and require `dialed-poc-observability.service`.

- [ ] **Step 6: Validate Alloy and verify GREEN**

Run:

```bash
docker run --rm -v "$PWD/ops/poc/observability/alloy/config.alloy:/etc/alloy/config.alloy:ro" grafana/alloy:v1.19.0 validate /etc/alloy/config.alloy
node --test ops/poc/test/alloy.test.mjs ops/poc/test/systemd.test.mjs
```

Expected: Alloy reports a valid configuration and both Node tests pass.

- [ ] **Step 7: Commit the collector slice**

```bash
git add ops/poc/observability/alloy/config.alloy ops/poc/systemd/dialed-poc-alloy.service ops/poc/test/alloy.test.mjs ops/poc/test/systemd.test.mjs
git commit -m "feat(ops): collect Pi metrics and journal logs"
```

### Task 5: Allowlisted operational metrics and operation outcomes

**Files:**

- Create: `ops/poc/bin/observe`
- Create: `ops/poc/bin/record-operation`
- Create: `ops/poc/systemd/dialed-poc-observe.service`
- Create: `ops/poc/systemd/dialed-poc-observe.timer`
- Create: `ops/poc/test/observe.test.mjs`
- Modify: `ops/poc/bin/backup`
- Modify: `ops/poc/bin/reconcile`
- Modify: `ops/poc/test/backup.test.mjs`
- Modify: `ops/poc/test/reconcile.test.mjs`
- Modify: `ops/poc/test/systemd.test.mjs`

**Interfaces:**

- Produces `/var/lib/dialed/observability/textfile/dialed.prom` atomically with fixed metric names.
- Produces root-owned state files `operations/backup.env` and `operations/deploy.env` with `RESULT`, `TIMESTAMP_SECONDS`, `REVISION`, and `REASON`.
- Consumes `/var/lib/dialed/active.env`, Docker Compose labels, `systemctl show`, the guard sentinel, and local readiness endpoints.

- [ ] **Step 1: Write failing snapshot and recorder tests**

Build fixtures with fake `docker`, `systemctl`, `curl`, and `date` commands. Require exactly these metric families:

```text
dialed_container_running{stack="poc",service="api"} 1
dialed_container_health_status{stack="poc",service="api",status="healthy"} 1
dialed_container_restart_count{stack="poc",service="api"} 2
dialed_active_revision_info{revision="0123456789abcdef0123456789abcdef01234567"} 1
dialed_operation_last_result{operation="backup",reason="scheduled",result="success"} 1
dialed_operation_last_timestamp_seconds{operation="backup",reason="scheduled"} 1787992500
dialed_observability_endpoint_up{service="grafana"} 1
dialed_observability_ingestion_stopped 0
```

Assert missing/unhealthy/starting/no-healthcheck states use the fixed status set, output replacement is atomic, a failed Docker query leaves the prior `.prom` file intact, container IDs never appear, and an unexpected service argument is rejected.

- [ ] **Step 2: Run operational tests and verify RED**

Run:

```bash
node --test ops/poc/test/observe.test.mjs
```

Expected: FAIL because both scripts and units do not exist.

- [ ] **Step 3: Implement atomic operation state recording**

`record-operation` must accept exactly:

```text
record-operation backup success|failure REVISION scheduled|predeploy
record-operation deploy success|failure REVISION release|force|rollback
```

Validate operation/result/reason enums and a lowercase 40-character revision, write a mode-`0600` temporary file in the destination directory, then rename it. `backup` and `reconcile` call it from exit cleanup with the original status saved, and clear the trap before returning that exact status. A missing operation directory or recorder failure is followed by `|| true` and cannot alter backup/reconcile results. Successful no-op reconcile runs do not overwrite the last meaningful deployment event; failed checks and actual force/release attempts do.

When reconciliation fails before either an active or candidate revision is known, record the all-zero revision `0000000000000000000000000000000000000000`. This is the only sentinel revision and keeps the recorder's schema valid without inventing a release identity.

- [ ] **Step 4: Implement the fixed-allowlist snapshot**

Hard-code service arrays rather than accepting them from environment:

```sh
poc_services='postgres api web cloudflared'
observability_services='grafana loki prometheus'
```

Resolve containers with exact Compose project/service labels, inspect running/health/restart fields, and probe only `http://127.0.0.1:3002/api/health`, `http://127.0.0.1:3100/ready`, and `http://127.0.0.1:9090/-/ready`. Escape only fixed/validated Prometheus label values. Write a complete temporary `.prom` file with mode `0640`, owner `root:alloy`, then rename it over `dialed.prom`.

- [ ] **Step 5: Add the snapshot systemd schedule**

The service is root-owned, one-shot, network-capability-free, and runs `/opt/dialed/bin/observe`. The timer uses:

```ini
[Timer]
OnBootSec=30s
OnUnitActiveSec=30s
AccuracySec=5s
Unit=dialed-poc-observe.service
Persistent=true
```

Add filesystem hardening without blocking Docker/systemd queries.

- [ ] **Step 6: Verify recorder failure isolation and snapshot GREEN**

Run:

```bash
node --test ops/poc/test/observe.test.mjs ops/poc/test/backup.test.mjs ops/poc/test/reconcile.test.mjs ops/poc/test/systemd.test.mjs
```

Expected: all tests pass, including explicit cases where `record-operation` exits nonzero while successful and failed backup/reconcile exit statuses remain unchanged.

- [ ] **Step 7: Commit the operational metrics slice**

```bash
git add ops/poc/bin/observe ops/poc/bin/record-operation ops/poc/bin/backup ops/poc/bin/reconcile ops/poc/systemd/dialed-poc-observe.service ops/poc/systemd/dialed-poc-observe.timer ops/poc/test/observe.test.mjs ops/poc/test/backup.test.mjs ops/poc/test/reconcile.test.mjs ops/poc/test/systemd.test.mjs
git commit -m "feat(ops): export allowlisted deployment metrics"
```

### Task 6: Storage ingestion guard

**Files:**

- Create: `ops/poc/bin/storage-guard`
- Create: `ops/poc/systemd/dialed-poc-storage-guard.service`
- Create: `ops/poc/systemd/dialed-poc-storage-guard.timer`
- Create: `ops/poc/test/storage-guard.test.mjs`
- Modify: `ops/poc/test/systemd.test.mjs`

**Interfaces:**

- Consumes `DIALED_OBSERVABILITY_DIR`, `DIALED_OBSERVABILITY_MAX_BYTES`, and `DIALED_OBSERVABILITY_MIN_FREE_BYTES`.
- Produces `/var/lib/dialed/observability/INGESTION_STOPPED` and the `dialed_observability_ingestion_stopped` input consumed by Task 5.
- May call only `systemctl stop dialed-poc-alloy.service`; it never deletes data or targets another unit.

- [ ] **Step 1: Write failing threshold and command-boundary tests**

Use fake `du`, `df`, `systemctl`, and `date` commands. Cover usage/free values below, exactly at, and above each limit. Assert the threshold rule is `used >= max || free < reserve`, the sentinel includes `reason`, `observed_bytes`, `threshold_bytes`, and UTC timestamp, and the only allowed stop command is:

```text
systemctl stop dialed-poc-alloy.service
```

Assert malformed/non-positive integer settings fail before `du`, `df`, or `systemctl`; paths containing newlines are rejected; and the script contains no `rm`, Docker command, application unit, PostgreSQL unit, or recursive file operation.

- [ ] **Step 2: Run guard tests and verify RED**

Run:

```bash
node --test ops/poc/test/storage-guard.test.mjs
```

Expected: FAIL because the guard and units do not exist.

- [ ] **Step 3: Implement byte-safe guard behavior**

Load the root-owned environment through `common`, validate decimal integers with shell patterns, resolve the containing filesystem using `df -PB1`, and obtain directory use with `du -sB1`. Write the sentinel atomically before stopping Alloy. If already stopped for the same active condition, update neither the sentinel nor systemd to avoid journal noise. Below thresholds, leave any sentinel in place; resumption is deliberately manual.

- [ ] **Step 4: Add the five-minute service and timer**

Use a root one-shot service with `NoNewPrivileges`, `PrivateTmp`, `ProtectHome`, and `ProtectSystem=full`. Configure:

```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=dialed-poc-storage-guard.service
Persistent=true
```

- [ ] **Step 5: Run guard/systemd verification and verify GREEN**

Run:

```bash
node --test ops/poc/test/storage-guard.test.mjs ops/poc/test/systemd.test.mjs
```

Expected: all threshold, allowlist, hardening, and timer assertions pass.

- [ ] **Step 6: Commit the storage guard slice**

```bash
git add ops/poc/bin/storage-guard ops/poc/systemd/dialed-poc-storage-guard.service ops/poc/systemd/dialed-poc-storage-guard.timer ops/poc/test/storage-guard.test.mjs ops/poc/test/systemd.test.mjs
git commit -m "feat(ops): stop telemetry before SSD exhaustion"
```

### Task 7: Installer, lifecycle, and journald integration

**Files:**

- Create: `ops/poc/bin/observability`
- Create: `ops/poc/systemd/dialed-poc-observability.service`
- Create: `ops/poc/observability/journald/90-dialed-poc.conf`
- Modify: `ops/poc/bin/install`
- Modify: `ops/poc/poc.env.example`
- Modify: `ops/poc/test/fixtures/poc.env`
- Modify: `compose.poc.yaml`
- Modify: `ops/poc/test/compose.test.mjs`
- Modify: `ops/poc/test/systemd.test.mjs`
- Modify: `ops/poc/test/observability-compose.test.mjs`

**Interfaces:**

- Consumes every file produced by Tasks 2–6.
- Produces `/opt/dialed/compose.observability.yaml`, `/opt/dialed/observability/**`, the required ownership tree, and enabled systemd units.
- Extends the secret contract with `DIALED_OBSERVABILITY_DIR`, `GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`, `DIALED_OBSERVABILITY_MAX_BYTES`, and `DIALED_OBSERVABILITY_MIN_FREE_BYTES`.

- [ ] **Step 1: Write failing installer and Compose integration tests**

Extend tests to require:

```dotenv
DIALED_OBSERVABILITY_DIR=/tmp/dialed-poc-test/observability
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=test-only-grafana-password-with-32-characters
DIALED_OBSERVABILITY_MAX_BYTES=5368709120
DIALED_OBSERVABILITY_MIN_FREE_BYTES=10737418240
```

Assert every POC service uses `logging.driver: journald` and logging metadata includes Compose service and `${APP_REVISION}`. Assert the installer checks `alloy --version` for `1.19.0`, checks `curl`, validates all three configurations before enabling units, rejects overlapping data/backup/observability paths, never overwrites `/etc/dialed/poc.env`, and does not recursively chown an existing component directory.

- [ ] **Step 2: Run integration tests and verify RED**

Run:

```bash
node --test ops/poc/test/compose.test.mjs ops/poc/test/observability-compose.test.mjs ops/poc/test/systemd.test.mjs
```

Expected: FAIL on missing environment, logging, lifecycle, and installer contracts.

- [ ] **Step 3: Extend and validate the environment contract**

Require a 32-character Grafana password, a non-empty admin user without whitespace/control characters, positive decimal byte limits, and an observability directory that is absolute, dedicated, and disjoint from data and backups in both containment directions. Keep the value-free example comments explicit about `5368709120` and `10737418240` defaults rather than silently defaulting production values.

- [ ] **Step 4: Install least-privilege storage and configuration paths**

Create the top-level path as root mode `0700`, then component children with exact runtime ownership:

```text
grafana       472:472       0700
loki          10001:10001   0700
prometheus    65534:65534   0700
alloy         alloy:alloy   0700
textfile      root:alloy    0750
operations    root:root     0700
```

For existing paths, validate directory/non-symlink/owner/mode instead of repairing recursively. Copy configuration to `/opt/dialed/observability` with root ownership and read-only modes, preserving the nested structure.

- [ ] **Step 5: Add safe lifecycle and configuration validation**

`ops/poc/bin/observability` accepts only `start`, `stop`, `status`, `logs`, and `config`; it loads the validated env and runs Docker Compose with `/opt/dialed/compose.observability.yaml`. The systemd unit is `Type=oneshot`, `RemainAfterExit=yes`, starts with `observability start`, stops with `observability stop`, and is ordered after Docker/network availability.

Before copying active host assets or enabling units, validate:

```bash
docker compose --env-file /etc/dialed/poc.env -f <staged-compose> config --quiet
/usr/bin/alloy validate <staged-alloy-config>
docker run --rm ... grafana/loki:3.7.6 -verify-config=true
docker run --rm --entrypoint promtool ... prom/prometheus:v3.13.2 check config ...
```

Pulling pinned observability images is an explicit host-assets installation action, not part of the minute application reconciler.

- [ ] **Step 6: Route POC stdout/stderr to bounded journald**

Add the journald driver to all POC services, including `migrate`, with stable service and revision metadata. Install a journald drop-in containing:

```ini
[Journal]
SystemMaxUse=512M
RuntimeMaxUse=128M
```

Reload/restart journald only after the new drop-in is atomically installed. Do not enable PostgreSQL statement logging.

- [ ] **Step 7: Enable units in dependency order**

After `systemctl daemon-reload`, enable/start:

```text
dialed-poc-observability.service
dialed-poc-observe.timer
dialed-poc-storage-guard.timer
dialed-poc-alloy.service
dialed-poc-deploy.timer
dialed-poc-backup.timer
```

If observability startup fails, report it without stopping/recreating the POC application Compose stack. The installer may exit nonzero but must leave Dialed running.

- [ ] **Step 8: Run the complete ops suite and verify GREEN**

Run:

```bash
pnpm test:ops
```

Expected: every Compose, config, shell, lifecycle, backup, reconcile, and systemd contract passes.

- [ ] **Step 9: Commit the host integration slice**

```bash
git add compose.poc.yaml ops/poc/bin/install ops/poc/bin/observability ops/poc/poc.env.example ops/poc/test/fixtures/poc.env ops/poc/systemd/dialed-poc-observability.service ops/poc/observability/journald/90-dialed-poc.conf ops/poc/test/compose.test.mjs ops/poc/test/observability-compose.test.mjs ops/poc/test/systemd.test.mjs
git commit -m "feat(ops): install SSH-only observability stack"
```

### Task 8: Runbook, teardown, and full release verification

**Files:**

- Modify: `ops/poc/README.md`
- Modify: `README.md`

**Interfaces:**

- Documents all operator-facing interfaces from Tasks 1–7.
- Produces no new runtime interface.

- [ ] **Step 1: Write the runbook sections**

Document the exact ARM64 Alloy install pin, environment values, installer command, status commands, and SSH access:

```bash
ssh -N -L 3002:127.0.0.1:3002 <pi-host>
```

State that the operator opens `http://localhost:3002`, signs in with the configured Grafana admin credentials, and closes the SSH process to remove workstation access.

- [ ] **Step 2: Document operations and recovery**

Include commands to inspect the four observability services, Alloy journal, metric snapshot, retention directories, and sentinel. Guard recovery must require checking `du`/`df`, fixing capacity, explicitly removing only `/var/lib/dialed/observability/INGESTION_STOPPED`, and starting `dialed-poc-alloy.service`. Do not provide any command that recursively deletes the observability root.

Document password rotation, reviewed version upgrades, the controlled POC container recreation needed to adopt journald, and the fact that logs/metrics are disposable and not in PostgreSQL backups.

- [ ] **Step 3: Document independent teardown**

Teardown order is: stop/disable Alloy and both observability timers, stop `dialed-poc-observability.service`, and leave `/etc/dialed/poc.env`, PostgreSQL, backups, deployment state, and the observability SSD directory intact by default. Any data deletion remains a separate explicit decision.

- [ ] **Step 4: Format and run focused verification**

Run:

```bash
pnpm format
pnpm --filter @dialed/api test
pnpm test:ops
pnpm format:check
pnpm lint
pnpm typecheck
```

Expected: all commands exit 0; test output contains no failures and formatting reports no differences.

- [ ] **Step 5: Run full repository verification**

Run:

```bash
pnpm test
pnpm test:db-integration
pnpm build
pnpm audit --prod --audit-level=high
```

Expected: unit/integration tests and builds pass, and the production audit reports no high or critical advisory.

- [ ] **Step 6: Render and inspect both Compose models**

Run:

```bash
docker compose --env-file ops/poc/test/fixtures/poc.env -f compose.poc.yaml config --quiet
docker compose --env-file ops/poc/test/fixtures/observability.env -f compose.observability.yaml config --format json
```

Expected: both render successfully; a manual read confirms only the three explicit `127.0.0.1` observability bindings and no application port.

- [ ] **Step 7: Commit documentation and formatting changes**

```bash
git add README.md ops/poc/README.md
git commit -m "docs: add Pi observability runbook"
```

- [ ] **Step 8: Perform Raspberry Pi acceptance before declaring deployment complete**

Follow the spec's ten acceptance checks on the Pi: install with observability stopped, start the stack, open the SSH forward, verify a request log, restart one allowlisted container, run backup and reconcile, confirm readiness/temperature/SSD/revision panels, stop observability without affecting Dialed, test the guard with a safe threshold, and verify LAN port 3002 is closed. Record the component versions and measured steady-state/peak memory in the deployment notes.

## Upstream References Locked by This Plan

- [Grafana Docker installation and current image naming](https://grafana.com/docs/grafana/latest/setup-grafana/installation/docker/)
- [Grafana minimum resource guidance](https://grafana.com/docs/grafana/latest/setup-grafana/installation/)
- [Loki Docker and ARM-compatible image guidance](https://grafana.com/docs/loki/latest/setup/install/docker/)
- [Loki compactor retention behavior](https://grafana.com/docs/loki/latest/operations/storage/retention/)
- [Prometheus storage retention and compaction behavior](https://prometheus.io/docs/prometheus/latest/storage/)
- [Prometheus 3.13 LTS lifecycle](https://prometheus.io/docs/introduction/release-cycle/)
- [Alloy journal permissions and relabel behavior](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.journal/)
- [Alloy Unix exporter and Pi-relevant collectors](https://grafana.com/docs/alloy/latest/reference/components/prometheus/prometheus.exporter.unix/)
