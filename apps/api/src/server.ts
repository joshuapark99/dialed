import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import type { SyncStore, StoredSyncOperation } from "@dialed/db";
import type { AuthService, Principal } from "./auth.js";
import {
  deleteAccountBodySchema,
  exportQuerySchema,
  pullQuerySchema,
  pushBodySchema,
} from "./contracts.js";

export interface ServerDependencies {
  auth: AuthService;
  store: SyncStore;
  logger?: boolean;
}

function csvCell(value: unknown): string {
  const stringValue =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${stringValue.replaceAll('"', '""')}"`;
}

function operationsToCsv(operations: StoredSyncOperation[]): string {
  const header =
    "revision,operationId,entity,entityId,action,receivedAt,payload";
  const rows = operations.map((operation) =>
    [
      operation.revision,
      operation.operationId,
      operation.entity,
      operation.entityId,
      operation.action,
      operation.receivedAt,
      operation.payload,
    ]
      .map(csvCell)
      .join(","),
  );
  return [header, ...rows].join("\n");
}

async function requirePrincipal(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: AuthService,
): Promise<Principal | null> {
  const principal = await auth.authenticate(request);
  if (!principal) {
    await reply
      .code(401)
      .send({ error: { code: "unauthorized", message: "Sign in required" } });
    return null;
  }
  return principal;
}

async function requireExpectedAccount(
  request: FastifyRequest,
  reply: FastifyReply,
  principal: Principal,
): Promise<boolean> {
  const accountHeader = request.headers["x-dialed-account-id"];
  const expectedAccountId = Array.isArray(accountHeader)
    ? accountHeader[0]
    : accountHeader;
  if (expectedAccountId === principal.id) return true;

  await reply.code(409).send({
    error: {
      code: "account_mismatch",
      message: "Authenticated account does not match the expected account",
      expectedAccountId: expectedAccountId ?? null,
      actualAccount: principal,
    },
  });
  return false;
}

export function createServer(
  dependencies: ServerDependencies,
): FastifyInstance {
  const app = Fastify({ logger: dependencies.logger ?? false });

  void app.register(swagger, {
    openapi: {
      info: {
        title: "Dialed API",
        description:
          "Authentication, synchronization, and account data for Dialed.",
        version: "0.1.0",
      },
      components: {
        securitySchemes: {
          session: {
            type: "apiKey",
            in: "cookie",
            name: "better-auth.session_token",
          },
        },
      },
    },
  });
  void app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    void reply.code(500).send({
      error: {
        code: "internal_error",
        message: "The request could not be completed",
      },
    });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  app.get("/readyz", async (_request, reply) => {
    try {
      await dependencies.store.health();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });

  if (dependencies.auth.handler) {
    app.all("/api/auth/*", async (request, reply) => {
      reply.hijack();
      await dependencies.auth.handler!(request.raw, reply.raw);
    });
  }

  app.get("/v1/me", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, dependencies.auth);
    if (!principal) return;
    return { user: principal };
  });

  app.post("/v1/sync/push", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, dependencies.auth);
    if (!principal) return;
    if (!(await requireExpectedAccount(request, reply, principal))) return;
    const parsed = pushBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Invalid sync operations",
          issues: parsed.error.issues,
        },
      });
    }
    const results = await dependencies.store.push(
      principal.id,
      parsed.data.operations,
    );
    return { results };
  });

  app.get("/v1/sync/pull", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, dependencies.auth);
    if (!principal) return;
    if (!(await requireExpectedAccount(request, reply, principal))) return;
    const parsed = pullQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "invalid_request",
          message: "Invalid sync cursor",
          issues: parsed.error.issues,
        },
      });
    }
    const operations = await dependencies.store.pull(
      principal.id,
      parsed.data.cursor,
      parsed.data.limit,
    );
    return {
      operations,
      cursor: operations.at(-1)?.revision ?? parsed.data.cursor,
      hasMore: operations.length === parsed.data.limit,
    };
  });

  app.get("/v1/account/export", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, dependencies.auth);
    if (!principal) return;
    const parsed = exportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Invalid format" },
      });
    }
    const operations = await dependencies.store.exportUser(principal.id);
    if (parsed.data.format === "csv") {
      return reply
        .type("text/csv; charset=utf-8")
        .header(
          "content-disposition",
          'attachment; filename="dialed-export.csv"',
        )
        .send(operationsToCsv(operations));
    }
    return reply
      .header(
        "content-disposition",
        'attachment; filename="dialed-export.json"',
      )
      .send({
        exportedAt: new Date().toISOString(),
        user: principal,
        operations,
      });
  });

  app.delete("/v1/account", async (request, reply) => {
    const principal = await requirePrincipal(request, reply, dependencies.auth);
    if (!principal) return;
    if (!(await requireExpectedAccount(request, reply, principal))) return;
    const parsed = deleteAccountBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: {
          code: "confirmation_required",
          message: 'Send {"confirmation":"DELETE"}',
        },
      });
    }
    await dependencies.store.deleteUser(principal.id);
    return reply.code(204).send();
  });

  return app;
}
