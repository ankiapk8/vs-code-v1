import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "WARNING: DATABASE_URL is not set. The database connection will fail unless configured.",
  );
}

const defaultUrl = "postgresql://localhost:5432/ankigen";
export const pool = new Pool({ connectionString: process.env.DATABASE_URL || defaultUrl });
export const db = drizzle(pool, { schema });

export async function ensureDatabaseSchema(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "decks" (
      "id" serial PRIMARY KEY NOT NULL,
      "name" text NOT NULL,
      "description" text,
      "parent_id" integer,
      "kind" text DEFAULT 'deck' NOT NULL,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "cards" (
      "id" serial PRIMARY KEY NOT NULL,
      "deck_id" integer NOT NULL,
      "front" text NOT NULL,
      "back" text NOT NULL,
      "tags" text,
      "image" text,
      "source_image" text,
      "bbox" text,
      "card_type" text,
      "choices" text,
      "correct_index" integer,
      "page_number" integer,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      "updated_at" timestamp with time zone DEFAULT now() NOT NULL
    );

    CREATE TABLE IF NOT EXISTS "generations" (
      "id" serial PRIMARY KEY NOT NULL,
      "deck_name" text NOT NULL,
      "deck_type" text NOT NULL,
      "status" text NOT NULL,
      "cards_generated" integer DEFAULT 0 NOT NULL,
      "page_count" integer DEFAULT 0 NOT NULL,
      "duration_ms" integer DEFAULT 0 NOT NULL,
      "custom_prompt" text,
      "error_message" text,
      "started_at" timestamp with time zone DEFAULT now() NOT NULL,
      "completed_at" timestamp with time zone
    );

    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "description" text;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "parent_id" integer;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'deck' NOT NULL;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
    ALTER TABLE "decks" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "tags" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "image" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "source_image" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "bbox" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "card_type" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "choices" text;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "correct_index" integer;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "page_number" integer;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now() NOT NULL;
    ALTER TABLE "cards" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'decks_parent_id_decks_id_fk'
      ) THEN
        ALTER TABLE "decks"
          ADD CONSTRAINT "decks_parent_id_decks_id_fk"
          FOREIGN KEY ("parent_id") REFERENCES "public"."decks"("id")
          ON DELETE set null ON UPDATE no action;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'cards_deck_id_decks_id_fk'
      ) THEN
        ALTER TABLE "cards"
          ADD CONSTRAINT "cards_deck_id_decks_id_fk"
          FOREIGN KEY ("deck_id") REFERENCES "public"."decks"("id")
          ON DELETE cascade ON UPDATE no action;
      END IF;
    END $$;
  `);
}

export * from "./schema";
