import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDatabase } from "./client.js";

const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

export async function migrateDatabase(databaseUrl: string): Promise<void> {
  const database = createDatabase(databaseUrl);
  try {
    await migrate(database.db, { migrationsFolder });
  } finally {
    await database.close();
  }
}
