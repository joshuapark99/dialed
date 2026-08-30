import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dataSourcesPath =
  "ops/poc/observability/grafana/provisioning/datasources/dialed.yaml";
const dashboardProviderPath =
  "ops/poc/observability/grafana/provisioning/dashboards/dialed.yaml";
const dashboardPath =
  "ops/poc/observability/grafana/dashboards/dialed-poc-overview.json";

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

const requiredPrometheusQueries = [
  '100 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100',
  "100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)",
  "100 * (1 - node_filesystem_avail_bytes / node_filesystem_size_bytes)",
  "max(node_hwmon_temp_celsius) or max(node_thermal_zone_temp)",
  "dialed_container_running",
  "dialed_container_health_status",
  "dialed_container_restart_count",
  "dialed_active_revision_info",
  "dialed_operation_last_timestamp_seconds",
  "dialed_observability_endpoint_up",
];

const requiredLokiQueries = [
  'sum(rate({service="api"} | json | msg="request completed" [5m]))',
  'quantile_over_time(0.95, {service="api"} | json | msg="request completed" | unwrap responseTime [5m])',
  'sum by (statusCode) (count_over_time({service="api"} | json | msg="request completed" [5m]))',
  '{environment="poc", service=~"$service", level=~"$level"}',
];

test("provisions locked internal Grafana data sources and dashboard provider", () => {
  const dataSources = readFileSync(dataSourcesPath, "utf8");
  const provider = readFileSync(dashboardProviderPath, "utf8");

  assert.match(dataSources, /^\s*access:\s*proxy\s*$/m);
  assert.match(dataSources, /^\s*url:\s*http:\/\/prometheus:9090\s*$/m);
  assert.match(dataSources, /^\s*uid:\s*dialed-prometheus\s*$/m);
  assert.match(dataSources, /^\s*url:\s*http:\/\/loki:3100\s*$/m);
  assert.match(dataSources, /^\s*uid:\s*dialed-loki\s*$/m);
  assert.match(dataSources, /^\s*isDefault:\s*true\s*$/m);
  assert.equal(
    (dataSources.match(/^\s*isDefault:\s*true\s*$/gm) ?? []).length,
    1,
  );
  assert.equal(
    (dataSources.match(/^\s*editable:\s*false\s*$/gm) ?? []).length,
    2,
  );
  assert.match(provider, /^\s*allowUiUpdates:\s*false\s*$/m);
  assert.match(provider, /^\s*path:\s*\/var\/lib\/grafana\/dashboards\s*$/m);
});

test("dashboard remains a locked, bounded, no-alert overview", () => {
  const dashboardText = readFileSync(dashboardPath, "utf8");
  const dashboard = JSON.parse(dashboardText);
  const serialized = JSON.stringify(dashboard);
  const queries = dashboard.panels.flatMap((panel) =>
    (panel.targets ?? []).map((target) => target.expr),
  );

  assert.equal(dashboard.uid, "dialed-poc-overview");
  assert.equal(dashboard.editable, false);
  assert.equal(dashboard.refresh, "30s");
  assert.equal(/\balert\b/i.test(serialized), false);
  assert.equal(/https?:\/\//i.test(serialized), false);

  for (const panel of requiredPanels) {
    assert.ok(
      dashboard.panels.some(({ title }) => title === panel),
      panel,
    );
  }

  for (const uid of ["dialed-prometheus", "dialed-loki"]) {
    assert.ok(serialized.includes(uid), uid);
  }

  for (const query of [...requiredPrometheusQueries, ...requiredLokiQueries]) {
    assert.ok(queries.includes(query), query);
  }

  const variables = Object.fromEntries(
    dashboard.templating.list.map((variable) => [variable.name, variable]),
  );
  assert.deepEqual(Object.keys(variables).sort(), [
    "level",
    "revision",
    "service",
  ]);
  for (const variable of Object.values(variables)) {
    assert.equal(variable.type, "custom");
    assert.equal(variable.includeAll, false);
    assert.equal(variable.multi, false);
  }
});

test("Grafana uses the provisioned dashboard as its home and mounts it read-only", () => {
  const compose = readFileSync("compose.observability.yaml", "utf8");

  assert.match(
    compose,
    /GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH:\s*\/var\/lib\/grafana\/dashboards\/dialed-poc-overview\.json/,
  );
  assert.match(compose, /target:\s*\/etc\/grafana\/provisioning/);
  assert.match(compose, /target:\s*\/var\/lib\/grafana\/dashboards/);
  assert.match(
    compose,
    /target:\s*\/etc\/grafana\/provisioning\s*\n\s*read_only:\s*true/,
  );
  assert.match(
    compose,
    /target:\s*\/var\/lib\/grafana\/dashboards\s*\n\s*read_only:\s*true/,
  );
  assert.equal(
    (compose.match(/target:\s*\/etc\/grafana\/provisioning/g) ?? []).length,
    1,
  );
  assert.equal(
    (compose.match(/target:\s*\/var\/lib\/grafana\/dashboards/g) ?? []).length,
    1,
  );
});
