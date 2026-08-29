import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { migrateDatabase } from "../src/migrate.js";

const databaseUrl = process.env.DIALED_INTEGRATION_DATABASE_URL;
assert.ok(databaseUrl, "DIALED_INTEGRATION_DATABASE_URL is required");

test("runtime migrations are idempotent and include the current schema", async () => {
  await migrateDatabase(databaseUrl);
  await migrateDatabase(databaseUrl);

  const sql = postgres(databaseUrl, { max: 1 });
  try {
    const [result] = await sql<
      [{ syncTable: string | null; coffeeEnum: boolean }]
    >`
      select
        to_regclass('public.sync_operation')::text as "syncTable",
        exists(
          select 1
          from pg_enum e
          join pg_type t on t.oid = e.enumtypid
          where t.typname = 'sync_entity' and e.enumlabel = 'coffee'
        ) as "coffeeEnum"
    `;

    assert.equal(result.syncTable, "sync_operation");
    assert.equal(result.coffeeEnum, true);
  } finally {
    await sql.end();
  }
});
