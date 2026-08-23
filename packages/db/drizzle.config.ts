import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "drizzle-kit";

if (!process.env.DATABASE_URL) {
  const repositoryEnvPath = fileURLToPath(
    new URL("../../.env", import.meta.url),
  );

  if (existsSync(repositoryEnvPath)) loadEnvFile(repositoryEnvPath);
}

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required to run Drizzle commands");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
