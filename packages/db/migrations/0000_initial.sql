CREATE TYPE "public"."temperature_control" AS ENUM('none', 'relative', 'precise');
--> statement-breakpoint
CREATE TYPE "public"."sync_entity" AS ENUM('bean', 'machine', 'grinder', 'brew', 'taste', 'recommendation');
--> statement-breakpoint
CREATE TYPE "public"."sync_action" AS ENUM('upsert', 'delete');
--> statement-breakpoint

CREATE TABLE "user" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean DEFAULT false NOT NULL,
  "image" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "session" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" ("user_id");
--> statement-breakpoint

CREATE TABLE "account" (
  "id" text PRIMARY KEY NOT NULL,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamp with time zone,
  "refresh_token_expires_at" timestamp with time zone,
  "scope" text,
  "password" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" ("user_id");
--> statement-breakpoint

CREATE TABLE "verification" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint

CREATE TABLE "user_preference" (
  "user_id" text PRIMARY KEY NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "temperature_unit" text DEFAULT 'celsius' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint

CREATE TABLE "bean" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "roaster" text,
  "origin" text,
  "roast_level" text,
  "roasted_on" date,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "bean_user_updated_idx" ON "bean" ("user_id", "updated_at");
--> statement-breakpoint

CREATE TABLE "machine_profile" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "manufacturer" text,
  "model" text,
  "temperature_control" "temperature_control" DEFAULT 'none' NOT NULL,
  "adjustable_pressure" boolean DEFAULT false NOT NULL,
  "supports_preinfusion" boolean DEFAULT false NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "machine_user_updated_idx" ON "machine_profile" ("user_id", "updated_at");
--> statement-breakpoint

CREATE TABLE "grinder_profile" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "manufacturer" text,
  "model" text,
  "step_size" numeric,
  "finer_direction" text,
  "minimum" numeric,
  "maximum" numeric,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "grinder_user_updated_idx" ON "grinder_profile" ("user_id", "updated_at");
--> statement-breakpoint

CREATE TABLE "brew" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "bean_id" uuid NOT NULL REFERENCES "bean"("id"),
  "machine_id" uuid NOT NULL REFERENCES "machine_profile"("id"),
  "grinder_id" uuid NOT NULL REFERENCES "grinder_profile"("id"),
  "method" text DEFAULT 'espresso' NOT NULL,
  "brewed_at" timestamp with time zone NOT NULL,
  "dose_grams" numeric NOT NULL,
  "yield_grams" numeric NOT NULL,
  "duration_seconds" numeric NOT NULL,
  "grind_display" text NOT NULL,
  "dialed_at" timestamp with time zone,
  "comparison_brew_id" uuid,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "brew_user_brewed_idx" ON "brew" ("user_id", "brewed_at");
--> statement-breakpoint

CREATE TABLE "espresso_detail" (
  "brew_id" uuid PRIMARY KEY NOT NULL REFERENCES "brew"("id") ON DELETE CASCADE,
  "temperature_celsius" numeric,
  "pressure_bar" numeric,
  "preinfusion_seconds" numeric,
  "basket" text,
  "puck_preparation" text,
  "observations" jsonb
);
--> statement-breakpoint

CREATE TABLE "taste_assessment" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "brew_id" uuid NOT NULL UNIQUE REFERENCES "brew"("id") ON DELETE CASCADE,
  "acidity" integer,
  "bitterness" integer,
  "strength" integer,
  "body" integer,
  "enjoyment" integer,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint

CREATE TABLE "recommendation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "brew_id" uuid NOT NULL UNIQUE REFERENCES "brew"("id") ON DELETE CASCADE,
  "adjustment" jsonb NOT NULL,
  "confidence" text NOT NULL,
  "rationale" text NOT NULL,
  "expected_effect" text NOT NULL,
  "rule_version" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  "revision" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint

CREATE TABLE "sync_operation" (
  "operation_id" uuid NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "entity" "sync_entity" NOT NULL,
  "entity_id" uuid NOT NULL,
  "action" "sync_action" NOT NULL,
  "payload" jsonb,
  "revision" integer NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "sync_operation_user_id_operation_id_pk" PRIMARY KEY("user_id", "operation_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "sync_user_revision_idx" ON "sync_operation" ("user_id", "revision");
--> statement-breakpoint
