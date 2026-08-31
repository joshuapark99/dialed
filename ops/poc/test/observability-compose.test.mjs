import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const lifecyclePath = resolve("ops/poc/bin/observability");
const commonPath = resolve("ops/poc/bin/common");

const composeVersion = spawnSync("docker", ["compose", "version"], {
  encoding: "utf8",
});
const composeUnavailable =
  composeVersion.error || composeVersion.status !== 0
    ? "Docker Compose is unavailable on this host; CI runs this contract"
    : false;

const ceilings = {
  grafana: { memory: 536_870_912, cpus: "1" },
  loki: { memory: 536_870_912, cpus: "1" },
  prometheus: { memory: 402_653_184, cpus: "1" },
};

test(
  "rendered observability topology stays loopback-only and constrained",
  { skip: composeUnavailable },
  () => {
    const rendered = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        "ops/poc/test/fixtures/observability.env",
        "-f",
        "compose.observability.yaml",
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);

    const model = JSON.parse(rendered.stdout);
    assert.equal(model.name, "dialed-observability");
    assert.equal(model.services.grafana.image, "grafana/grafana:13.1.3");
    assert.equal(model.services.loki.image, "grafana/loki:3.7.6");
    assert.equal(model.services.prometheus.image, "prom/prometheus:v3.13.2");
    assert.deepEqual(model.services.grafana.ports[0].host_ip, "127.0.0.1");
    assert.equal(model.services.grafana.ports[0].published, "3002");
    assert.equal(model.services.loki.ports[0].host_ip, "127.0.0.1");
    assert.equal(model.services.prometheus.ports[0].host_ip, "127.0.0.1");
    assert.deepEqual(Object.keys(model.networks), ["observability"]);
    assert.equal(model.networks.observability.driver, "bridge");
    assert.equal(model.networks.observability.internal, true);

    for (const [name, ceiling] of Object.entries(ceilings)) {
      const service = model.services[name];
      assert.deepEqual(service.networks, { observability: null });
      assert.equal(service.restart, "unless-stopped");
      assert.deepEqual(service.cap_drop, ["ALL"]);
      assert.ok(service.security_opt.includes("no-new-privileges:true"));
      assert.equal(Number(service.mem_limit), ceiling.memory);
      assert.equal(String(service.cpus), ceiling.cpus);
      assert.equal(
        JSON.stringify(service.volumes ?? []).includes("docker.sock"),
        false,
      );
    }

    assert.deepEqual(model.services.grafana.ports, [
      {
        mode: "ingress",
        target: 3000,
        published: "3002",
        protocol: "tcp",
        host_ip: "127.0.0.1",
      },
    ]);
    assert.deepEqual(model.services.loki.ports, [
      {
        mode: "ingress",
        target: 3100,
        published: "3100",
        protocol: "tcp",
        host_ip: "127.0.0.1",
      },
    ]);
    assert.deepEqual(model.services.prometheus.ports, [
      {
        mode: "ingress",
        target: 9090,
        published: "9090",
        protocol: "tcp",
        host_ip: "127.0.0.1",
      },
    ]);
    assert.ok(
      model.services.prometheus.command.includes(
        "--web.enable-remote-write-receiver",
      ),
    );
    assert.equal(
      model.services.prometheus.command.includes("--web.enable-admin-api"),
      false,
    );
  },
);

test("storage configurations retain data within the required bounds", () => {
  const loki = readFileSync("ops/poc/observability/loki.yaml", "utf8");
  const prometheus = readFileSync(
    "ops/poc/observability/prometheus.yaml",
    "utf8",
  );

  assert.match(loki, /^\s*retention_period:\s*336h\s*$/m);
  assert.match(loki, /^\s*period:\s*24h\s*$/m);
  assert.match(loki, /^\s*retention_enabled:\s*true\s*$/m);
  assert.match(loki, /^\s*deletion_mode:\s*disabled\s*$/m);
  assert.match(prometheus, /^\s*time:\s*30d\s*$/m);
  assert.match(prometheus, /^\s*size:\s*1GB\s*$/m);
});

test("observability lifecycle has a narrow, separate Compose interface", () => {
  const lifecycle = readFileSync("ops/poc/bin/observability", "utf8");

  assert.match(lifecycle, /case "\$command" in/);
  assert.match(lifecycle, /start \| stop \| status \| logs \| config/);
  assert.match(lifecycle, /\*\) die "usage: observability/);
  assert.match(lifecycle, /\/opt\/dialed\/compose\.observability\.yaml/);
  assert.match(
    lifecycle,
    /docker compose --env-file "\$DIALED_ENV_FILE" -f "\$DIALED_OBSERVABILITY_COMPOSE_FILE"/,
  );
});

function shellValue(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function lifecycleFixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), "dialed-observability-lifecycle-"));
  const bin = join(root, "bin");
  const compose = join(root, "compose.observability.yaml");
  const config = join(root, "config");
  const environment = join(root, "poc.env");
  const dockerLog = join(root, "docker.log");
  const data = join(root, "data");
  const backups = join(root, "backups");
  const observability = join(root, "observability");
  mkdirSync(bin);
  mkdirSync(config);
  writeFileSync(compose, "name: dialed-observability\n", { mode: 0o644 });
  writeFileSync(dockerLog, "", { mode: 0o600 });
  writeFileSync(
    join(bin, "docker"),
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >>"$DIALED_DOCKER_LOG"\n',
    { mode: 0o755 },
  );
  const values = {
    DIALED_DATA_DIR: data,
    DIALED_BACKUP_DIR: backups,
    DIALED_OBSERVABILITY_DIR: observability,
    GRAFANA_ADMIN_USER: "admin",
    GRAFANA_ADMIN_PASSWORD: "test-only-grafana-password-with-32-characters",
    DIALED_OBSERVABILITY_MAX_BYTES: "5368709120",
    DIALED_OBSERVABILITY_MIN_FREE_BYTES: "10737418240",
    ...overrides,
  };
  writeFileSync(
    environment,
    `${Object.entries(values)
      .map(([name, value]) => `${name}=${shellValue(value)}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );

  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { bin, compose, config, dockerLog, environment, root };
}

function runLifecycle(value, verb) {
  return spawnSync("sh", [lifecyclePath, verb], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${value.bin}:${process.env.PATH}`,
      DIALED_DOCKER_LOG: value.dockerLog,
      DIALED_ENV_FILE: value.environment,
      DIALED_OBSERVABILITY_COMPOSE_FILE: value.compose,
      DIALED_OBSERVABILITY_CONFIG_DIR: value.config,
    },
  });
}

test("every lifecycle verb validates observability input before Compose", (t) => {
  const value = lifecycleFixture(t, { GRAFANA_ADMIN_USER: "admin\noperator" });

  for (const verb of ["start", "stop", "status", "logs", "config"]) {
    const result = runLifecycle(value, verb);
    assert.notEqual(result.status, 0, `${verb} unexpectedly invoked Compose`);
    assert.match(result.stderr, /GRAFANA_ADMIN_USER/);
  }
  assert.equal(readFileSync(value.dockerLog, "utf8"), "");
});

test("lifecycle rejects semantic Grafana, limit, and path violations", (t) => {
  const root = mkdtempSync(join(tmpdir(), "dialed-observability-invalid-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const data = join(root, "data");
  const backups = join(root, "backups");
  const observability = join(root, "observability");
  const cases = [
    [
      "carriage return",
      { GRAFANA_ADMIN_USER: "admin\roperator" },
      /GRAFANA_ADMIN_USER/,
    ],
    ["tab", { GRAFANA_ADMIN_USER: "admin\toperator" }, /GRAFANA_ADMIN_USER/],
    ["space", { GRAFANA_ADMIN_USER: "admin operator" }, /GRAFANA_ADMIN_USER/],
    [
      "control",
      { GRAFANA_ADMIN_USER: "admin\u0001operator" },
      /GRAFANA_ADMIN_USER/,
    ],
    [
      "short password",
      { GRAFANA_ADMIN_PASSWORD: "x".repeat(31) },
      /GRAFANA_ADMIN_PASSWORD/,
    ],
    [
      "zero limit",
      { DIALED_OBSERVABILITY_MAX_BYTES: "0" },
      /DIALED_OBSERVABILITY_MAX_BYTES/,
    ],
    [
      "nondecimal limit",
      { DIALED_OBSERVABILITY_MIN_FREE_BYTES: "10MiB" },
      /DIALED_OBSERVABILITY_MIN_FREE_BYTES/,
    ],
    [
      "relative observability path",
      { DIALED_OBSERVABILITY_DIR: "observability" },
      /DIALED_OBSERVABILITY_DIR/,
    ],
    [
      "non-dedicated observability path",
      { DIALED_OBSERVABILITY_DIR: "/observability" },
      /DIALED_OBSERVABILITY_DIR/,
    ],
    [
      "observability inside data",
      {
        DIALED_DATA_DIR: data,
        DIALED_OBSERVABILITY_DIR: join(data, "observability"),
      },
      /DIALED_DATA_DIR and DIALED_OBSERVABILITY_DIR/,
    ],
    [
      "data inside observability",
      {
        DIALED_DATA_DIR: join(observability, "data"),
        DIALED_OBSERVABILITY_DIR: observability,
      },
      /DIALED_DATA_DIR and DIALED_OBSERVABILITY_DIR/,
    ],
    [
      "observability inside backups",
      {
        DIALED_BACKUP_DIR: backups,
        DIALED_OBSERVABILITY_DIR: join(backups, "observability"),
      },
      /DIALED_BACKUP_DIR and DIALED_OBSERVABILITY_DIR/,
    ],
    [
      "backups inside observability",
      {
        DIALED_BACKUP_DIR: join(observability, "backups"),
        DIALED_OBSERVABILITY_DIR: observability,
      },
      /DIALED_BACKUP_DIR and DIALED_OBSERVABILITY_DIR/,
    ],
  ];

  for (const [name, overrides, errorPattern] of cases) {
    const value = lifecycleFixture(t, overrides);
    const result = runLifecycle(value, "config");
    assert.notEqual(result.status, 0, `${name} was accepted`);
    assert.match(
      result.stderr,
      errorPattern,
      `${name} failed for the wrong reason`,
    );
    assert.equal(
      readFileSync(value.dockerLog, "utf8"),
      "",
      `${name} reached Compose`,
    );
  }
});

test("Alloy version validation parses and accepts only the exact release", () => {
  for (const output of [
    "alloy, version v1.19.0 (branch: HEAD, revision: abc123)",
    "alloy, version 1.19.0 (branch: release)",
  ]) {
    const result = spawnSync(
      "sh",
      [
        "-c",
        `. ${shellValue(commonPath)}; require_alloy_version "$1"`,
        "sh",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
  }
  for (const output of [
    "alloy, version v1.19.0-rc.1 (branch: release)",
    "alloy, version v1.19.0+build (branch: release)",
    "alloy, version v1.19.0.1 (branch: release)",
    "alloy, version v1.19.1 (branch: release)",
  ]) {
    const result = spawnSync(
      "sh",
      [
        "-c",
        `. ${shellValue(commonPath)}; require_alloy_version "$1"`,
        "sh",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.notEqual(result.status, 0, `${output} was accepted`);
  }
});
