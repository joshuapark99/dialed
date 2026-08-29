# Raspberry Pi POC Hosting and CI/CD Design

## Summary

Dialed will gain a repeatable proof-of-concept deployment for a 64-bit Raspberry Pi using Docker Compose, Cloudflare Tunnel, and Cloudflare Access. The public repository will continue to use GitHub-hosted runners for all untrusted or repository-defined workflow execution. Successful `main` builds will publish immutable multi-platform web and API images to GitHub Container Registry (GHCR), while a fixed systemd timer on the Pi will pull and reconcile those images without exposing SSH or installing a GitHub self-hosted runner.

The POC is for the owner and invited testers. It is not a production environment with a service-level objective. Its design still protects credentials and PostgreSQL, verifies every deployment, preserves the last working application images, and creates a database backup before migrations.

## Goals

- Restore a green CI pipeline on the supported Node.js versions.
- Remove known high- and critical-severity vulnerabilities from the production dependency graph.
- Build reproducible `linux/arm64` and `linux/amd64` web and API images.
- Publish commit-addressable images only after every release gate passes.
- Host Dialed on a 64-bit Raspberry Pi without opening router ports.
- Require Cloudflare Access authentication for browser traffic.
- Keep the API and PostgreSQL inaccessible from the host network and Internet.
- Deploy successful `main` revisions automatically through an outbound-only pull process.
- Run database migrations once before a new API revision starts.
- Verify web, API, database, and externally routed health after deployment.
- Roll application containers back to their prior image digests after a failed deployment.
- Back up PostgreSQL before migrations and on a daily schedule.
- Document bootstrap, secrets, OAuth, updates, recovery, and teardown.

## Non-goals

- Production uptime, high availability, or zero-downtime database migrations.
- Automatically restoring a database backup after a failed migration.
- Exposing SSH through Cloudflare Tunnel.
- Running GitHub Actions jobs on the Raspberry Pi.
- Provisioning the Cloudflare account, DNS zone, Access policies, or Google OAuth application through Terraform.
- Committing a tunnel token, OAuth credential, database password, or application secret.
- Automatically changing host-level systemd units or Compose infrastructure on every application deployment.
- Supporting 32-bit Raspberry Pi operating systems.
- Replacing PostgreSQL with a managed cloud database for this POC.

## Platform Assumptions

- Raspberry Pi 4 with at least 4 GB RAM or Raspberry Pi 5.
- A 64-bit Raspberry Pi OS or another supported 64-bit Debian-family distribution.
- Application and PostgreSQL data reside on a USB SSD rather than an SD card.
- Docker Engine and Docker Compose v2 are installed on the Pi.
- The Pi can make outbound HTTPS connections to GitHub, GHCR, Cloudflare, and Google.
- A domain in an active Cloudflare zone is available for the POC hostname.
- The GitHub repository and the two GHCR images are public. Images contain no runtime secrets.

## System Topology

```text
Invited tester
    |
    v
Cloudflare Access
    |
    v
Cloudflare edge
    |
    | outbound-only tunnel connection
    v
cloudflared container
    |
    v
web container :3000
    |
    | same-origin /api rewrites on the private Docker network
    v
api container :3001
    |
    v
PostgreSQL container :5432
```

Only the Cloudflare hostname is public. The POC Compose file publishes no host ports. `cloudflared` and the web service share a private ingress network. Web, API, the one-shot migration service, and PostgreSQL share a private application network. PostgreSQL is not attached to the ingress network.

The tunnel route sends the POC hostname to `http://web:3000`. The web build embeds `http://api:3001` as `API_INTERNAL_URL`, preserving the current same-origin browser model for `/api/v1/*` and `/api/auth/*`.

## Cloudflare Tunnel and Access

The deployment uses a remotely managed named tunnel. Its token is stored only on the Pi in the root-readable POC environment file. Quick Tunnels and `trycloudflare.com` URLs are not used.

The POC hostname has one Cloudflare Access self-hosted application with two policies:

1. An Allow policy for the owner's and invited testers' exact email addresses. One-time PIN is sufficient initially; a dedicated identity provider can be added later without changing the origin.
2. A Service Auth policy matching one narrowly scoped service token used only by the GitHub-hosted external smoke-test job.

All unmatched requests are denied. The tunnel route enables Cloudflare Access protection so a request that reaches the connector without satisfying the Access application is rejected. The Access session duration is 24 hours for the initial POC.

The service token credentials are stored as GitHub environment secrets named `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`. The token is never passed to the Pi and cannot administer Cloudflare. The tunnel token is never passed to GitHub Actions.

Cloudflare Access adds an authentication layer in front of Dialed; it does not replace Dialed authentication. Invited testers who use cloud sync still sign in through Dialed's Google OAuth flow.

## Runtime Configuration and Secrets

The operator creates `/etc/dialed/poc.env` on the Pi with mode `0600`. It supplies:

- `APP_URL`, set to the exact HTTPS POC origin.
- `BETTER_AUTH_SECRET`, generated with at least 32 cryptographically random bytes.
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB`.
- `TUNNEL_TOKEN` for the named Cloudflare tunnel.
- `DIALED_DATA_DIR`, located on the SSD.
- `DIALED_BACKUP_DIR`, located on the SSD and separate from the live PostgreSQL directory.

The repository contains a value-free `ops/poc/poc.env.example` describing every required variable. Compose interpolation fails when a required value is missing; it does not provide development secrets as production fallbacks.

Google OAuth registers this callback exactly:

```text
${APP_URL}/api/auth/callback/google
```

The runtime also receives `APP_REVISION`, derived from the OCI revision label on the selected images. Secrets are runtime variables and are never Docker build arguments.

## Production Images

The existing root Dockerfile remains the single build definition and retains separate `web` and `api` targets.

### Web image

- Builds the Next.js standalone output with `API_INTERNAL_URL=http://api:3001`.
- Contains only the standalone server, static assets, and public assets required at runtime.
- Runs as a non-root user.
- Exposes port 3000 internally.
- Includes OCI source and revision labels.
- Implements a container health check against `/healthz`.

### API image

- Compiles the API and database workspace packages.
- Contains only the API runtime dependency closure, compiled output, and database migrations.
- Does not copy the build stage's complete `node_modules` tree.
- Does not include TypeScript, Vitest, Drizzle Kit, or other development tooling.
- Runs as a non-root user.
- Exposes port 3001 internally.
- Includes OCI source and revision labels.
- Implements a container health check against `/readyz`.

### Runtime migrations

Database migrations run through a compiled Node.js entry point backed by Drizzle ORM's PostgreSQL migrator. The entry point and SQL migration directory ship in the API image. Production migration does not require `drizzle-kit` or pnpm.

The same API image is used by a one-shot `migrate` Compose service. PostgreSQL must be healthy before migration starts. The API service must not start until migration exits successfully.

Both image targets build for `linux/arm64` and `linux/amd64`. Base images and third-party runtime images use explicit supported versions rather than floating `latest` tags.

## Health and Revision Reporting

The web app exposes dynamic `GET /healthz` with:

```json
{ "status": "ok", "revision": "<git-commit>" }
```

The API keeps `GET /healthz` for process liveness and `GET /readyz` for database readiness. Both include the same revision. Next.js adds same-origin rewrites for `/api/healthz` and `/api/readyz` so external verification never needs a second public hostname.

Container health checks use local endpoints. The GitHub external smoke job checks `/healthz` and `/api/readyz` through Cloudflare Access and requires both revisions to equal the commit that produced the images.

## CI Design

The CI workflow runs on pull requests and pushes to `main`. Repository code executes only on GitHub-hosted runners.

### Portable verification

- Pure file-watching helpers are tested with explicit platform and workspace inputs. Tests do not expect the imported Next.js configuration to behave as if every runner path begins with `/mnt/`.
- Sync tests that exercise reset or destructive owner operations inject an explicit cross-context-safe fake lock. A separate unit test proves that an unsafe lock is rejected. Tests do not depend on whether the Node.js runtime happens to expose `navigator.locks`.
- Unit, type, and build verification runs on Node.js 22 and Node.js 24.
- Browser end-to-end verification runs once on Node.js 22, matching the minimum supported and container major version.
- The repository includes version-manager metadata that selects Node.js 22 for local release verification.

### Required CI gates

1. Frozen dependency installation.
2. Formatting check.
3. Lint.
4. Type checking.
5. Unit and integration tests.
6. Production dependency audit with zero critical or high advisories. Any remaining moderate advisory must be documented with its dependency path and exposure rationale.
7. Production build.
8. PostgreSQL migration integration test, including a second idempotent migration run.
9. API readiness check against the migrated PostgreSQL service.
10. Playwright browser suite.
11. POC Compose configuration validation.
12. Docker builds for both production targets.

Workflow actions are pinned to full commit SHAs with a nearby version comment. Job permissions default to `contents: read`; only the image-publishing job receives `packages: write`, `attestations: write`, and `id-token: write`.

## Image Publication

After all CI gates pass for a push to `main`, a GitHub-hosted job publishes:

- `ghcr.io/joshuapark99/dialed-web:sha-<git-commit>`
- `ghcr.io/joshuapark99/dialed-api:sha-<git-commit>`
- Mutable `poc` discovery tags for the same two manifests.

Each manifest supports `linux/arm64` and `linux/amd64`. Both images carry `org.opencontainers.image.source` and `org.opencontainers.image.revision` labels. The job creates artifact provenance attestations for the published digests.

The SHA tags are immutable and are the durable release identity. The `poc` tag is only a discovery pointer that lets the Pi notice a new release.

## Pull-Based Deployment

The Pi runs a root-owned systemd timer once per minute. The corresponding one-shot service executes `ops/poc/bin/reconcile`, protected by `flock` so deployments and scheduled backups cannot overlap.

The reconciler performs these steps:

1. Load `/etc/dialed/poc.env` and the last successful deployment state.
2. Pull both `poc` discovery tags.
3. Resolve each pulled image to an exact registry digest.
4. Read and compare the images' OCI revision labels; refuse mixed revisions.
5. Exit successfully without restarting anything when the resolved digests already match the active state.
6. Save the active web/API digests as the rollback state.
7. Create a compressed PostgreSQL pre-deployment backup.
8. Write a temporary Compose environment containing the candidate exact digests and revision.
9. Run the one-shot migration service with the candidate API image.
10. Start or replace the API and web services with the exact candidate digests.
11. Wait conditionally for local web health and API readiness to report the candidate revision.
12. Atomically promote the candidate environment to the active deployment state.
13. Remove unused application images while preserving the active and rollback digests.

Compose always starts application containers from exact digest references stored in the active deployment state. It never relies on a mutable tag after discovery.

### Failure and rollback

- A pull or digest-resolution failure leaves the current deployment untouched.
- A mixed web/API revision is rejected before backup or migration.
- A backup failure stops deployment before migration.
- A migration failure leaves existing application containers running and retains the backup.
- A health or readiness failure restarts web and API with the saved prior digests.
- Automatic rollback never restores PostgreSQL. Schema migrations must remain backward compatible with the previous application revision, and a database restore remains an explicit operator recovery action.
- The script exits nonzero and logs a concise failure reason to journald after any failed candidate.
- Three failed candidates do not disable the timer; repeated attempts are harmless because the migration runner is idempotent and the active state remains digest-pinned. The operator can pause the timer while investigating.

## External Deployment Verification

After publishing images, a GitHub-hosted job polls the Access-protected health endpoints for up to ten minutes. Requests include the Cloudflare Access service-token headers. Success requires both endpoints to return HTTP 200 and the pushed commit revision.

If the Pi is offline, the tunnel is disconnected, Access is misconfigured, reconciliation fails, or the prior revision remains active, the external verification job fails. Published immutable images remain available, but GitHub does not report the revision as successfully deployed.

The workflow uses a `poc` GitHub environment and a single non-canceling deployment concurrency group so two releases cannot race external verification. Only pushes to `main` can publish or verify a deployment; pull-request workflows never receive Cloudflare credentials.

## PostgreSQL Storage and Backups

PostgreSQL uses a bind-mounted directory under `DIALED_DATA_DIR` on the SSD. The deployment does not publish port 5432.

`ops/poc/bin/backup` acquires the same deployment lock, runs `pg_dump` in custom format, verifies that the output is nonempty, and writes it under `DIALED_BACKUP_DIR` with a UTC timestamp and revision metadata. A daily systemd timer runs the command. The local retention policy keeps fourteen daily backups.

The setup guide explicitly requires the operator to copy backups off the Pi to another device or storage provider. Off-device transport credentials and provider-specific synchronization are outside this repository's scope.

Restore is a documented manual procedure that stops application writes, verifies the selected backup, restores into PostgreSQL, reruns migrations, and checks readiness before reopening the tunnel route. No automated path deletes or overwrites the live database.

## Dependency and Container Hardening

- Upgrade or override the vulnerable `sharp`, PostCSS, and `@fastify/static` paths identified by the production audit.
- Remove development-only Drizzle Kit and legacy esbuild paths from the API runtime image.
- Keep Swagger documentation available for the POC but behind the same Cloudflare Access application.
- Run production containers as non-root users with `no-new-privileges` and all Linux capabilities dropped unless a documented runtime requirement proves otherwise.
- Use read-only filesystems for web, API, migration, and cloudflared where compatible, with explicit temporary filesystems for writable runtime paths.
- Keep PostgreSQL on the private application network and limit its persistent mount to the database service.
- Add restart policies to long-running services; one-shot migration and backup tasks do not restart indefinitely.
- Never mount the Docker socket into an application or third-party long-running container.

## Operational Files

The implementation creates the following POC-specific units:

- `compose.poc.yaml`: secure Pi topology using exact application image variables.
- `ops/poc/poc.env.example`: value-free runtime variable contract.
- `ops/poc/bin/reconcile`: pull, migrate, verify, promote, and rollback logic.
- `ops/poc/bin/backup`: locked PostgreSQL backup and retention logic.
- `ops/poc/systemd/dialed-poc-deploy.service` and `.timer`: application reconciliation.
- `ops/poc/systemd/dialed-poc-backup.service` and `.timer`: daily backup.
- `ops/poc/README.md`: Pi bootstrap, Cloudflare, Access, OAuth, GHCR, operations, recovery, and teardown.

Host-level files are installed explicitly during bootstrap and are not silently replaced by normal application CD. Updating Compose topology, scripts, or systemd units requires the operator to review a successful repository revision and rerun the documented installation step.

## Testing Strategy

### Unit tests

- File-watching behavior is independent of the test runner's actual filesystem path.
- Cross-context lock requirements are independent of the test runner's Node.js globals.
- Health payloads include the configured revision.
- Deployment helper functions reject missing digests, mixed revisions, malformed state, and empty backups.

### Integration tests

- Runtime migrations apply to an empty PostgreSQL database and are idempotent.
- API readiness fails before a database is available and succeeds after migrations.
- The POC Compose model contains no published host ports.
- Web-to-API routing resolves over the private Compose network.
- Candidate deployment state is promoted only after both local health checks pass.
- A simulated failed candidate selects the previous exact digests.
- Backup retention preserves the newest fourteen valid archives.

### Container and architecture tests

- Both Docker targets build for `linux/amd64` and `linux/arm64`.
- The API runtime image does not contain development-only executables or packages.
- Containers start as non-root.
- Health checks reach the intended local endpoints.

### End-to-end checks

- Existing desktop and mobile Playwright coverage remains green.
- External smoke requests without Access credentials are denied.
- Service-token requests reach both health endpoints.
- Both endpoints report the release commit after reconciliation.
- Google OAuth returns to the exact POC callback through Access.

## Rollout Sequence

1. Fix portable CI tests and align Node.js verification.
2. Patch the production dependency graph and slim runtime images.
3. Add runtime migration and health/revision support.
4. Add POC Compose, reconciliation, backup, and systemd assets.
5. Add multi-platform image publication and external verification.
6. Bootstrap the Pi with the tunnel disabled.
7. Validate local container health, migrations, backup, rollback, and restart behavior.
8. Create the named tunnel and Access application.
9. Register the production-style Google OAuth callback.
10. Enable the tunnel route for invited testers.

## Success Criteria

- GitHub CI is green on `main` under Node.js 22 and 24.
- The production audit reports no critical or high advisories.
- GHCR contains matching multi-platform web and API manifests for a `main` commit.
- The Pi exposes no application, API, database, or SSH host port.
- Unauthenticated requests to the POC hostname are blocked by Cloudflare Access.
- A successful push to `main` reaches the Pi without manual commands and is reported by both health endpoints using the same commit revision.
- A failed candidate leaves or restores the last healthy application digest pair.
- PostgreSQL survives container replacement and produces verified scheduled backups.
- The setup and recovery guide can reproduce the POC from a clean 64-bit Pi installation.

## References

- [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [Cloudflare Access for self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use)
- [Publishing Docker images with GitHub Actions](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images)
