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
