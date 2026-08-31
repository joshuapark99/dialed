import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configPath = "ops/poc/observability/alloy/config.alloy";

function readConfig() {
  return readFileSync(configPath, "utf8");
}

function relabelRules(config) {
  return [...config.matchAll(/  rule \{([\s\S]*?)\n  \}/g)].map(
    (match) => match[1],
  );
}

function ruleSetting(rule, name) {
  return rule.match(new RegExp(`^\\s*${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
}

function priorityMappings(config) {
  const mappings = [];
  for (const rule of relabelRules(config)) {
    if (!rule.includes("__journal_priority_keyword")) continue;
    const regex = ruleSetting(rule, "regex");
    const replacement = ruleSetting(rule, "replacement");
    if (regex && replacement) mappings.push({ regex, replacement });
  }
  return mappings;
}

function pinoMappings(config) {
  const mappings = new Map();
  const selectors = [
    ...config.matchAll(/selector\s*=\s*"\{pino_level=~\\"\(([^)]*)\)\\"\}"/g),
  ];
  for (const [index, selector] of selectors.entries()) {
    const start = selector.index + selector[0].length;
    const end = selectors[index + 1]?.index ?? config.length;
    const segment = config.slice(start, end);
    const normalized = segment.match(
      /level\s*=\s*"(debug|info|warn|error)"/,
    )?.[1];
    assert.ok(normalized, `missing normalized level after ${selector[1]}`);
    for (const value of selector[1].split("|")) mappings.set(value, normalized);
  }
  return mappings;
}

test("Alloy collects only allowlisted journal streams with low-cardinality labels", () => {
  const config = readConfig();
  const rules = relabelRules(config);

  for (const component of [
    "loki.source.journal",
    "loki.relabel",
    "loki.process",
    "loki.write",
  ]) {
    assert.match(
      config,
      new RegExp(`^${component.replace(/\\./g, "\\\\.")}`, "m"),
    );
  }

  assert.match(config, /format_as_json\s*=\s*false/);
  for (const label of [
    "__journal__systemd_unit",
    "__journal_container_name",
    "__journal_priority_keyword",
  ]) {
    assert.match(config, new RegExp(label));
  }
  for (const expectedRule of [
    [
      "__journal_container_name",
      "dialed-poc-(api|web|postgres|migrate|cloudflared)-1",
    ],
    [
      "__journal_container_name",
      "dialed-observability-(grafana|loki|prometheus)-1",
    ],
    [
      "__journal__systemd_unit",
      "dialed-poc-(deploy|backup|observe|storage-guard|alloy)",
    ],
  ]) {
    assert.ok(
      rules.some(
        (rule) =>
          rule.includes('source_labels = ["' + expectedRule[0] + '"]') &&
          rule.includes('regex         = "' + expectedRule[1]) &&
          rule.includes('target_label  = "service"') &&
          rule.includes('replacement   = "$1"'),
      ),
      "missing canonical service mapping for " + expectedRule[1],
    );
  }
  assert.match(
    config,
    /dialed-poc-\(api\|web\|postgres\|migrate\|cloudflared\)-1/,
  );
  assert.match(config, /dialed-observability-\(grafana\|loki\|prometheus\)-1/);
  assert.match(
    config,
    /dialed-poc-\(deploy\|backup\|observe\|storage-guard\|alloy\).*service/,
  );

  for (const field of [
    "level",
    "requestId",
    "method",
    "route",
    "statusCode",
    "responseTime",
    "revision",
    "msg",
  ]) {
    assert.match(config, new RegExp(`\\b${field}\\b`));
  }
  assert.match(
    config,
    /stage\.label_keep\s*\{\s*values\s*=\s*\["level", "service", "environment", "revision"\]/,
  );
  assert.doesNotMatch(
    config,
    /values\s*=\s*\{[\s\S]*(requestId|route|method|statusCode|responseTime|msg)[\s\S]*\}/,
  );
  assert.ok(
    config.includes(
      'selector            = "{service=~\\"(grafana|loki|prometheus|alloy)\\", level=~\\"(debug|info)\\"}"',
    ),
  );
  assert.match(config, /http:\/\/127\.0\.0\.1:3100\/loki\/api\/v1\/push/);
});

test("Alloy normalizes bounded Pino and journald levels with validated revision metadata", () => {
  const config = readConfig();
  const journalMappings = priorityMappings(config);
  const pino = pinoMappings(config);

  for (const [input, expected] of Object.entries({
    emerg: "error",
    alert: "error",
    crit: "error",
    err: "error",
    error: "error",
    warning: "warn",
    warn: "warn",
    notice: "info",
    info: "info",
    debug: "debug",
  })) {
    const mapping = journalMappings.find(({ regex }) =>
      new RegExp(regex).test(input),
    );
    assert.equal(mapping?.replacement, expected, input);
  }

  for (const [input, expected] of Object.entries({
    10: "debug",
    20: "debug",
    30: "info",
    40: "warn",
    50: "error",
    60: "error",
  })) {
    assert.equal(pino.get(input), expected, `Pino ${input}`);
  }

  assert.match(
    config,
    /source_labels\s*=\s*\["__journal_io_dialed_revision"\]/,
  );
  assert.match(config, /regex\s*=\s*"\(\[0-9a-f\]\{40\}\)"/);
  assert.match(config, /target_label\s*=\s*"revision"/);
  assert.match(
    config,
    /stage\.label_keep\s*\{\s*values\s*=\s*\["level", "service", "environment", "revision"\]/,
  );
  assert.doesNotMatch(
    config,
    /target_label\s*=\s*"(?:requestId|rawUrl|containerId|user|path|error)"/,
  );
});

test("Alloy exports bounded host and textfile metrics to local Prometheus", () => {
  const config = readConfig();

  for (const component of [
    "prometheus.exporter.unix",
    "prometheus.scrape",
    "prometheus.remote_write",
  ]) {
    assert.match(
      config,
      new RegExp(`^${component.replace(/\\./g, "\\\\.")}`, "m"),
    );
  }
  for (const collector of [
    "cpu",
    "cpufreq",
    "diskstats",
    "filesystem",
    "hwmon",
    "loadavg",
    "meminfo",
    "netclass",
    "netdev",
    "pressure",
    "stat",
    "thermal_zone",
    "time",
    "timex",
    "textfile",
  ]) {
    assert.match(config, new RegExp(`"${collector}"`));
  }
  assert.match(
    config,
    /directory\s*=\s*"\/run\/dialed-observability\/textfile"/,
  );
  assert.match(config, /fs_types_exclude\s*=/);
  assert.match(config, /mount_points_exclude\s*=\s*"[^"\n]*overlay[^"\n]*"/);
  assert.match(config, /device_exclude\s*=\s*"\^veth/);
  assert.match(config, /ignored_devices\s*=\s*"\^veth/);
  assert.match(config, /scrape_interval\s*=\s*"30s"/);
  assert.match(config, /http:\/\/127\.0\.0\.1:9090\/api\/v1\/write/);
  assert.match(config, /capacity\s*=\s*500/);
  assert.match(config, /max_shards\s*=\s*1/);
  assert.match(config, /min_shards\s*=\s*1/);
  assert.match(config, /max_samples_per_send\s*=\s*250/);
  assert.match(config, /prometheus\.exporter\.self/);
});

test("Alloy has no Docker discovery, socket access, disk queue, clustering, or remote config", () => {
  const config = readConfig();

  assert.doesNotMatch(config, /docker\.sock|discovery\.docker/);
  assert.doesNotMatch(config, /wal_directory|queue_directory|disk-backed/i);
  assert.doesNotMatch(config, /clustering|remote\.config/);
});
