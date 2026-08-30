import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

const composeVersion = spawnSync("docker", ["compose", "version"], {
  encoding: "utf8",
});
const composeUnavailable =
  composeVersion.error || composeVersion.status !== 0
    ? "Docker Compose is unavailable on this host; CI runs this contract"
    : false;

test(
  "rendered POC topology exposes no ports and preserves network boundaries",
  { skip: composeUnavailable },
  () => {
    const rendered = spawnSync(
      "docker",
      [
        "compose",
        "--env-file",
        "ops/poc/test/fixtures/poc.env",
        "-f",
        "compose.poc.yaml",
        "config",
        "--format",
        "json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(rendered.status, 0, rendered.stderr || rendered.stdout);

    const model = JSON.parse(rendered.stdout);
    for (const service of Object.values(model.services)) {
      assert.deepEqual(service.ports ?? [], []);
      assert.equal(
        JSON.stringify(service.volumes ?? []).includes("docker.sock"),
        false,
      );
      assert.equal(service.logging.driver, "journald");
      assert.equal(service.logging.options["tag"], "dialed-poc/{{.Name}}");
      assert.equal(
        service.logging.options["labels"],
        "com.docker.compose.service,io.dialed.revision",
      );
      assert.equal(
        service.labels["io.dialed.revision"],
        "0123456789abcdef0123456789abcdef01234567",
      );
    }

    assert.deepEqual(model.services.postgres.networks, { app: null });
    assert.deepEqual(Object.keys(model.services.migrate.networks), ["app"]);
    assert.deepEqual(Object.keys(model.services.web.networks).sort(), [
      "app",
      "ingress",
    ]);
    assert.deepEqual(Object.keys(model.services.api.networks).sort(), [
      "api-egress",
      "app",
    ]);
    assert.deepEqual(Object.keys(model.services.cloudflared.networks).sort(), [
      "ingress",
      "tunnel-egress",
    ]);

    assert.equal(model.networks.app.internal, true);
    assert.equal(model.networks.ingress.internal, true);
    assert.notEqual(model.networks["api-egress"].internal, true);
    assert.notEqual(model.networks["tunnel-egress"].internal, true);

    assert.equal(model.services.migrate.restart, "no");
    assert.equal(
      model.services.api.depends_on.migrate.condition,
      "service_completed_successfully",
    );

    for (const name of ["migrate", "api", "web", "cloudflared"]) {
      const service = model.services[name];
      assert.equal(service.read_only, true);
      assert.deepEqual(service.cap_drop, ["ALL"]);
      assert.ok(service.security_opt.includes("no-new-privileges:true"));
    }
  },
);
