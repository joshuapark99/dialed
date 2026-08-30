import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

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
