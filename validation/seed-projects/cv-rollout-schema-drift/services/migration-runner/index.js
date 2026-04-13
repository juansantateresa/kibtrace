import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createLogger } from "../../shared/logger.js";
import { envStr } from "../../shared/env.js";

const { Client } = pg;

const SERVICE_NAME = "migration-runner";
const SERVICE_VERSION = envStr("SERVICE_VERSION", "1.0.0");
const SERVICE_ENV = envStr("SERVICE_ENVIRONMENT", "staging");
const DEPLOYMENT_VERSION = envStr("DEPLOYMENT_VERSION", "deploy-2026-04-12-rollout-b");
const DATABASE_URL = envStr("DATABASE_URL", "postgres://kibtrace:kibtrace@postgres:5432/detections");
const MIGRATIONS_DIR = envStr("MIGRATIONS_DIR", "/app/migrations");

const log = createLogger(SERVICE_NAME, SERVICE_VERSION, {
  "deployment.version": DEPLOYMENT_VERSION,
  "service.environment": SERVICE_ENV,
});

async function connectDb() {
  for (let attempt = 1; attempt <= 30; attempt++) {
    const client = new Client({ connectionString: DATABASE_URL });
    try {
      await client.connect();
      log.info("Connected to database", { attempt });
      return client;
    } catch (err) {
      log.warn("Waiting for postgres connection", {
        "error.message": err.message,
        attempt,
      });
      await delay(1000);
    }
  }
  throw new Error("Could not connect to postgres after 30 attempts");
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations(client) {
  const res = await client.query("SELECT name FROM schema_migrations ORDER BY id");
  return new Set(res.rows.map((r) => r.name));
}

async function runMigrations(client) {
  log.info("Applying migrations", { migrationsDir: MIGRATIONS_DIR });

  await ensureMigrationsTable(client);
  const applied = await getAppliedMigrations(client);

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  log.info("Found migration files", { count: files.length, files });

  // Only apply migration 001. Migration 002 exists in the repo but is
  // intentionally skipped — it would create detection_events_v2.
  // This simulates a real-world scenario where the migration was written
  // but not yet applied to this environment.
  const applicableFiles = files.filter((f) => f.startsWith("001"));

  for (const file of applicableFiles) {
    if (applied.has(file)) {
      log.info("Migration already applied, skipping", { migration: file });
      continue;
    }

    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    log.info(`Applying migration ${file}`, { migration: file });

    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);

    log.info(`Applied migration ${file}`, { migration: file });
  }

  log.info("Migration run complete", {
    totalFiles: files.length,
    applied: applicableFiles.filter((f) => !applied.has(f)).length,
    skipped: applicableFiles.filter((f) => applied.has(f)).length,
  });
}

async function main() {
  log.info("Migration runner starting", {
    "deployment.version": DEPLOYMENT_VERSION,
  });

  const client = await connectDb();
  await runMigrations(client);
  await client.end();

  log.info("Migration runner finished");
}

main().catch((err) => {
  log.fatal("Migration runner failed", {
    "error.message": err.message,
    "error.stack_trace": err.stack,
  });
  process.exit(1);
});
