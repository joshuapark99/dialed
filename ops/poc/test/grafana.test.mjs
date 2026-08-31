import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dataSourcesPath =
  "ops/poc/observability/grafana/provisioning/datasources/dialed.yaml";
const dashboardProviderPath =
  "ops/poc/observability/grafana/provisioning/dashboards/dialed.yaml";
const dashboardPath =
  "ops/poc/observability/grafana/dashboards/dialed-poc-overview.json";
const observePath = "ops/poc/bin/observe";
const backupPath = "ops/poc/bin/backup";
const reconcilePath = "ops/poc/bin/reconcile";

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
  'sum(rate({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" [5m]))',
  'quantile_over_time(0.95, {environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | unwrap responseTime [5m])',
  'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"2.." [5m]))',
  'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"3.." [5m]))',
  'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"4.." [5m]))',
  'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"5.." [5m]))',
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
    assert.ok(
      queries.some((candidate) => candidate.includes(query)),
      query,
    );
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
    assert.equal(variable.multi, false);
  }
  assert.equal(variables.service.type, "custom");
  assert.equal(variables.service.includeAll, false);
  assert.equal(variables.level.type, "custom");
  assert.equal(variables.level.includeAll, false);
  assert.equal(variables.revision.type, "query");
  assert.equal(variables.revision.includeAll, true);
});

test("log variables and API queries consume the complete bounded label contract", () => {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const variables = Object.fromEntries(
    dashboard.templating.list.map((variable) => [variable.name, variable]),
  );
  const services = [
    "alloy",
    "api",
    "backup",
    "cloudflared",
    "deploy",
    "grafana",
    "loki",
    "migrate",
    "observe",
    "postgres",
    "prometheus",
    "storage-guard",
    "web",
  ];

  assert.deepEqual(
    variables.service.options.map(({ value }) => value).sort(),
    services,
  );
  assert.equal(variables.service.query, services.join(","));
  assert.deepEqual(
    variables.level.options.map(({ value }) => value),
    ["debug", "info", "warn", "error"],
  );
  assert.equal(variables.revision.datasource.uid, "dialed-loki");
  assert.match(String(variables.revision.query), /label_values/);
  assert.match(String(variables.revision.query), /service="api"/);
  assert.equal(variables.revision.allValue, "[0-9a-f]{40}");

  for (const title of [
    "API request rate",
    "API p95 response time",
    "API status classes",
  ]) {
    const panel = dashboard.panels.find(
      (candidate) => candidate.title === title,
    );
    assert.ok(panel, title);
    for (const target of panel.targets) {
      assert.match(target.expr, /environment="poc"/);
      assert.match(target.expr, /service="api"/);
      assert.match(target.expr, /revision=~"\$revision"/);
    }
  }

  for (const title of ["Recent errors", "Dialed logs"]) {
    const panel = dashboard.panels.find(
      (candidate) => candidate.title === title,
    );
    assert.doesNotMatch(panel.targets[0].expr, /revision/);
  }
});

test("service health gives each health, runtime, and readiness state its own semantics", () => {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const panel = dashboard.panels.find(
    ({ title }) => title === "Service health",
  );

  assert.deepEqual(
    panel.targets.map(({ expr, refId }) => [refId, expr]),
    [
      ["A", 'dialed_container_health_status{status="healthy"}'],
      ["B", 'dialed_container_health_status{status="unhealthy"}'],
      ["C", 'dialed_container_health_status{status="starting"}'],
      ["D", 'dialed_container_health_status{status="none"}'],
      ["E", "dialed_container_running"],
      ["F", "dialed_observability_endpoint_up"],
    ],
  );
  assert.deepEqual(panel.fieldConfig.defaults.mappings, []);

  const stateMappings = new Map(
    panel.fieldConfig.overrides.map((override) => [
      override.matcher.options,
      override.properties.find(({ id }) => id === "mappings")?.value[0].options,
    ]),
  );
  for (const [refId, expected] of [
    ["A", { color: "green", text: "Healthy" }],
    ["B", { color: "red", text: "Unhealthy" }],
    ["C", { color: "yellow", text: "Starting" }],
    ["D", { color: "gray", text: "No health check" }],
  ]) {
    assert.deepEqual(stateMappings.get(refId)?.["1"], expected, refId);
  }
  assert.deepEqual(stateMappings.get("E"), {
    0: { color: "red", text: "Stopped" },
    1: { color: "green", text: "Running" },
  });
  assert.deepEqual(stateMappings.get("F"), {
    0: { color: "red", text: "Endpoint down" },
    1: { color: "green", text: "Ready" },
  });
});

test("API status panel uses four bounded status-class LogQL series", () => {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const panel = dashboard.panels.find(
    ({ title }) => title === "API status classes",
  );

  assert.deepEqual(
    panel.targets.map(({ expr, legendFormat, refId }) => [
      refId,
      legendFormat,
      expr,
    ]),
    [
      [
        "A",
        "2xx",
        'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"2.." [5m]))',
      ],
      [
        "B",
        "3xx",
        'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"3.." [5m]))',
      ],
      [
        "C",
        "4xx",
        'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"4.." [5m]))',
      ],
      [
        "D",
        "5xx",
        'sum(count_over_time({environment="poc", service="api", revision=~"$revision"} | json | msg="request completed" | statusCode=~"5.." [5m]))',
      ],
    ],
  );
  assert.doesNotMatch(JSON.stringify(panel.targets), /sum by \(statusCode\)/);
});

test("operation producers, observe, and dashboards share the failure result enum", () => {
  const dashboard = JSON.parse(readFileSync(dashboardPath, "utf8"));
  const observe = readFileSync(observePath, "utf8");

  for (const producerPath of [backupPath, reconcilePath]) {
    assert.match(
      readFileSync(producerPath, "utf8"),
      /operation_result=failure/,
    );
  }
  assert.match(observe, /result="%s"/);
  assert.match(observe, /(?:backup|deploy):failure:/);

  for (const operation of ["deployment", "backup"]) {
    const panel = dashboard.panels.find(
      ({ title }) => title === `Last ${operation}`,
    );
    const resultTarget = panel.targets.find(({ refId }) => refId === "B");
    const resultOverride = panel.fieldConfig.overrides.find(
      ({ matcher }) => matcher.id === "byFrameRefID" && matcher.options === "B",
    );

    assert.equal(
      panel.targets.find(({ refId }) => refId === "A").expr,
      `dialed_operation_last_timestamp_seconds{operation="${operation}"}`,
    );
    assert.equal(panel.fieldConfig.defaults.thresholds, undefined);
    assert.ok(resultTarget, `${operation} result target`);
    assert.equal(
      resultTarget.expr,
      `dialed_operation_last_result{operation="${operation}",result="failure"}`,
    );
    assert.ok(resultOverride, `${operation} result color override`);
    const thresholds = resultOverride.properties.find(
      ({ id }) => id === "thresholds",
    ).value;
    assert.deepEqual(thresholds, {
      mode: "absolute",
      steps: [
        { color: "green", value: null },
        { color: "red", value: 1 },
      ],
    });
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
