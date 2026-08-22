import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema.js";

export type DialedDatabase = PostgresJsDatabase<typeof schema>;

export interface DatabaseClient {
  db: DialedDatabase;
  sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string): DatabaseClient {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const sql = postgres(databaseUrl, { max: 10 });
  return {
    db: drizzle(sql, { schema }),
    sql,
    close: () => sql.end(),
  };
}
