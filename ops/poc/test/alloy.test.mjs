import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const configPath = "ops/poc/observability/alloy/config.alloy";

function readConfig() {
  return readFileSync(configPath, "utf8");
}

test("Alloy collects only allowlisted journal streams with low-cardinality labels", () => {
  const config = readConfig();

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
  assert.match(
    config,
    /source_labels = \["__journal_container_name"\]\s+target_label  = "service"\s+regex         = "\(\.\+\)"/,
  );
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
      'selector            = "{service=~\\"(grafana|loki|prometheus|alloy)\\", level=~\\"(info|debug)\\"}"',
    ),
  );
  assert.match(config, /http:\/\/127\.0\.0\.1:3100\/loki\/api\/v1\/push/);
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
    /directory\s*=\s*"\/var\/lib\/dialed\/observability\/textfile"/,
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
