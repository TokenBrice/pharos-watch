/**
 * Vitest global setup: build the latest-schema SQLite template once per run.
 *
 * Every isolated test file otherwise replays all `worker/migrations/*.sql`
 * (~100ms locally, more on CI) before its first fixture. The template is keyed
 * by a sha256 over the sorted migration names and bytes, written atomically
 * under `.cache/`, and restored by each fixture process. A build failure is
 * never cached: workers then fall back to replaying migrations per process.
 */
import { mkdirSync } from "node:fs";
import { atomicWriteFileSync } from "../lib/atomic-artifact-write.mts";
import {
  buildLatestSchemaTemplate,
  LATEST_SCHEMA_TEMPLATE_CACHE_DIR,
  latestSchemaTemplateCachePath,
  latestSchemaTemplateKey,
  readLatestSchemaTemplateCache,
} from "../../shared/test-utils/latest-schema-sqlite";

function prepareLatestSchemaSqliteTemplate({
  cacheDir = LATEST_SCHEMA_TEMPLATE_CACHE_DIR,
  migrationsDir,
}: { cacheDir?: string; migrationsDir?: string } = {}): {
  key: string;
  cachePath: string;
  status: "cached" | "built";
} {
  const key = latestSchemaTemplateKey(migrationsDir);
  const cachePath = latestSchemaTemplateCachePath(key, cacheDir);
  if (readLatestSchemaTemplateCache(cachePath)) return { key, cachePath, status: "cached" };
  const template = buildLatestSchemaTemplate(migrationsDir);
  mkdirSync(cacheDir, { recursive: true });
  atomicWriteFileSync(cachePath, template);
  return { key, cachePath, status: "built" };
}

export default async function prepareLatestSchemaSqliteTemplateForVitest(): Promise<void> {
  try {
    const { key, cachePath, status } = prepareLatestSchemaSqliteTemplate();
    if (status === "built") console.log(`[vitest-setup] built latest-schema SQLite template ${key} (${cachePath})`);
  } catch (error) {
    // The fixture helper replays migrations when the cache is absent, so a
    // failed template build must not fail the run or leave a partial file.
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[vitest-setup] latest-schema SQLite template unavailable; fixtures will replay migrations per process: ${reason}`);
  }
}
