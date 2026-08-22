import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const auditColumns = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  revision: integer("revision").notNull().default(1),
});

export const temperatureControl = pgEnum("temperature_control", [
  "none",
  "relative",
  "precise",
]);
export const syncEntity = pgEnum("sync_entity", [
  "bean",
  "machine",
  "grinder",
  "brew",
  "taste",
  "recommendation",
]);
export const syncAction = pgEnum("sync_action", ["upsert", "delete"]);

// Better Auth's core tables. The string IDs also allow accounts imported from providers.
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => [index("session_user_idx").on(table.userId)],
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("account_user_idx").on(table.userId)],
);

export const verifications = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const userPreferences = pgTable("user_preference", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  temperatureUnit: text("temperature_unit").notNull().default("celsius"),
  ...auditColumns(),
});

export const beans = pgTable(
  "bean",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    roaster: text("roaster"),
    origin: text("origin"),
    roastLevel: text("roast_level"),
    roastedOn: date("roasted_on"),
    notes: text("notes"),
    ...auditColumns(),
  },
  (table) => [index("bean_user_updated_idx").on(table.userId, table.updatedAt)],
);

export const machineProfiles = pgTable(
  "machine_profile",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    temperatureControl: temperatureControl("temperature_control")
      .notNull()
      .default("none"),
    adjustablePressure: boolean("adjustable_pressure").notNull().default(false),
    supportsPreinfusion: boolean("supports_preinfusion")
      .notNull()
      .default(false),
    notes: text("notes"),
    ...auditColumns(),
  },
  (table) => [
    index("machine_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const grinderProfiles = pgTable(
  "grinder_profile",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    manufacturer: text("manufacturer"),
    model: text("model"),
    stepSize: numeric("step_size"),
    finerDirection: text("finer_direction"),
    minimum: numeric("minimum"),
    maximum: numeric("maximum"),
    notes: text("notes"),
    ...auditColumns(),
  },
  (table) => [
    index("grinder_user_updated_idx").on(table.userId, table.updatedAt),
  ],
);

export const brews = pgTable(
  "brew",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    beanId: uuid("bean_id")
      .notNull()
      .references(() => beans.id),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machineProfiles.id),
    grinderId: uuid("grinder_id")
      .notNull()
      .references(() => grinderProfiles.id),
    method: text("method").notNull().default("espresso"),
    brewedAt: timestamp("brewed_at", { withTimezone: true }).notNull(),
    doseGrams: numeric("dose_grams").notNull(),
    yieldGrams: numeric("yield_grams").notNull(),
    durationSeconds: numeric("duration_seconds").notNull(),
    grindDisplay: text("grind_display").notNull(),
    dialedAt: timestamp("dialed_at", { withTimezone: true }),
    comparisonBrewId: uuid("comparison_brew_id"),
    notes: text("notes"),
    ...auditColumns(),
  },
  (table) => [index("brew_user_brewed_idx").on(table.userId, table.brewedAt)],
);

export const espressoDetails = pgTable("espresso_detail", {
  brewId: uuid("brew_id")
    .primaryKey()
    .references(() => brews.id, { onDelete: "cascade" }),
  temperatureCelsius: numeric("temperature_celsius"),
  pressureBar: numeric("pressure_bar"),
  preinfusionSeconds: numeric("preinfusion_seconds"),
  basket: text("basket"),
  puckPreparation: text("puck_preparation"),
  observations: jsonb("observations").$type<string[]>(),
});

export const tasteAssessments = pgTable("taste_assessment", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  brewId: uuid("brew_id")
    .notNull()
    .unique()
    .references(() => brews.id, { onDelete: "cascade" }),
  acidity: integer("acidity"),
  bitterness: integer("bitterness"),
  strength: integer("strength"),
  body: integer("body"),
  enjoyment: integer("enjoyment"),
  notes: text("notes"),
  ...auditColumns(),
});

export const recommendations = pgTable("recommendation", {
  id: uuid("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  brewId: uuid("brew_id")
    .notNull()
    .unique()
    .references(() => brews.id, { onDelete: "cascade" }),
  adjustment: jsonb("adjustment").$type<Record<string, unknown>>().notNull(),
  confidence: text("confidence").notNull(),
  rationale: text("rationale").notNull(),
  expectedEffect: text("expected_effect").notNull(),
  ruleVersion: text("rule_version").notNull(),
  ...auditColumns(),
});

export const syncOperations = pgTable(
  "sync_operation",
  {
    operationId: uuid("operation_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entity: syncEntity("entity").notNull(),
    entityId: uuid("entity_id").notNull(),
    action: syncAction("action").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    revision: integer("revision").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.operationId] }),
    uniqueIndex("sync_user_revision_idx").on(table.userId, table.revision),
  ],
);

export type SyncEntity = (typeof syncEntity.enumValues)[number];
export type SyncAction = (typeof syncAction.enumValues)[number];
