import { createDatabase, PostgresSyncStore } from "@dialed/db";
import { createBetterAuthService } from "./auth.js";
import { readConfig } from "./config.js";
import { createProductionLoggerOptions } from "./logger.js";
import { createServer } from "./server.js";

const config = readConfig();
const database = createDatabase(config.DATABASE_URL);
const auth = createBetterAuthService({
  db: database.db,
  baseUrl: config.APP_URL,
  secret: config.BETTER_AUTH_SECRET,
  googleClientId: config.GOOGLE_CLIENT_ID,
  googleClientSecret: config.GOOGLE_CLIENT_SECRET,
});
const app = createServer({
  auth,
  store: new PostgresSyncStore(database.db),
  revision: config.APP_REVISION,
  logger: createProductionLoggerOptions(config.APP_REVISION),
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error);
  await database.close();
  process.exit(1);
}
