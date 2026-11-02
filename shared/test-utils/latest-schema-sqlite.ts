import type { D1Database } from "@shared/types/cloudflare-runtime";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteD1, type SqliteD1Options } from "./sqlite-d1";

const MIGRATIONS_DIR = path.resolve(__dirname, "../../worker/migrations");
export const LATEST_SCHEMA_TEMPLATE_CACHE_DIR = path.resolve(__dirname, "../../.cache/vitest-latest-schema-sqlite");

// Migration files are immutable during a test run, and replaying all of them
// costs ~100ms per database. The migrated schema is therefore built once by
// `scripts/test/prepare-latest-schema-sqlite-template.ts` (Vitest globalSetup),
// written under `.cache/` keyed by migration content, and restored per fixture
// (~0.06ms). Every fixture still owns resizeable storage and shares nothing
// with the template bytes or with any other fixture. A missing, stale or
// corrupt cache entry falls back to replaying migrations in this process.
const cachedTemplates = new Map<string, Uint8Array>();

function migrationNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

/** sha256 over sorted migration file names and bytes; independent of mtimes. */
export function latestSchemaTemplateKey(migrationsDir: string = MIGRATIONS_DIR): string {
  const hash = createHash("sha256");
  for (const name of migrationNames(migrationsDir)) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path.join(migrationsDir, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function latestSchemaTemplateCachePath(key: string, cacheDir: string = LATEST_SCHEMA_TEMPLATE_CACHE_DIR): string {
  return path.join(cacheDir, `${key}.sqlite`);
}

export function buildLatestSchemaTemplate(migrationsDir: string = MIGRATIONS_DIR): Uint8Array {
  const sqlite = new DatabaseSync(":memory:");
  try {
    for (const name of migrationNames(migrationsDir)) {
      sqlite.exec(readFileSync(path.join(migrationsDir, name), "utf8"));
    }
    return sqlite.serialize();
  } finally {
    sqlite.close();
  }
}

/**
 * Reads a serialized template written by the global setup. `deserialize()` is
 * lazy, so truncated or unrelated bytes are only rejected by a schema read;
 * `PRAGMA quick_check` makes that verdict here. Returns undefined on any miss.
 */
export function readLatestSchemaTemplateCache(cachePath: string): Uint8Array | undefined {
  let sqlite: DatabaseSync | undefined;
  try {
    const bytes = new Uint8Array(readFileSync(cachePath));
    sqlite = new DatabaseSync(":memory:");
    sqlite.deserialize(bytes);
    return Object.values(sqlite.prepare("PRAGMA quick_check").get() ?? {})[0] === "ok" ? bytes : undefined;
  } catch {
    return undefined;
  } finally {
    sqlite?.close();
  }
}

function templateFor(cacheDir: string): Uint8Array {
  const cached = cachedTemplates.get(cacheDir);
  if (cached) return cached;
  const fromDisk = readLatestSchemaTemplateCache(latestSchemaTemplateCachePath(latestSchemaTemplateKey(), cacheDir));
  // A failed build is never cached: the assignment only runs on success.
  const template = fromDisk ?? buildLatestSchemaTemplate();
  cachedTemplates.set(cacheDir, template);
  return template;
}

function openLatestSchemaSqlite(
  options: SqliteD1Options,
  openDatabases?: Set<DatabaseSync>,
  uncached = false,
  templateCacheDir: string = LATEST_SCHEMA_TEMPLATE_CACHE_DIR,
) {
  const sqlite = new DatabaseSync(":memory:");
  openDatabases?.add(sqlite);
  try {
    if (uncached) {
      for (const name of migrationNames(MIGRATIONS_DIR)) {
        sqlite.exec(readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"));
      }
    } else {
      sqlite.deserialize(templateFor(templateCacheDir));
    }
    return { sqlite, db: createSqliteD1(sqlite, options) };
  } catch (error) {
    sqlite.close();
    openDatabases?.delete(sqlite);
    throw error;
  }
}

export function createLatestSchemaSqlite(options: SqliteD1Options = {}): { sqlite: DatabaseSync; db: D1Database } {
  return openLatestSchemaSqlite(options);
}

/** Reads `worker/migrations` fresh on every open, bypassing the per-process cache. Use when the migration inventory itself is under test. */
export function createLatestSchemaSqliteUncached(options: SqliteD1Options = {}): { sqlite: DatabaseSync; db: D1Database } {
  return openLatestSchemaSqlite(options, undefined, true);
}

export function createLatestSchemaFixtureTracker(options: { uncached?: boolean; templateCacheDir?: string } = {}) {
  const uncached = options.uncached === true;
  const templateCacheDir = options.templateCacheDir ?? LATEST_SCHEMA_TEMPLATE_CACHE_DIR;
  const openDatabases = new Set<DatabaseSync>();
  const open = () => openLatestSchemaSqlite({}, openDatabases, uncached, templateCacheDir);
  const closeAll = () => {
    const errors: unknown[] = [];
    for (const sqlite of openDatabases) {
      try {
        if (sqlite.isOpen) sqlite.close();
        openDatabases.delete(sqlite);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, "Failed to close SQLite fixtures");
  };
  return { open, closeAll };
}
