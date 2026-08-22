/**
 * Generate the homepage bootstrap payload embedded into the static shell.
 *
 * `--check` validates the checked-in payload shape and endpoint schemas without
 * making network calls, so local and PR builds do not fail on live API drift.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyFreshnessRatio } from "@shared/lib/status-thresholds";
import {
  apiFetchHeaders,
  GENERATOR_API_KEY_ENV_NAMES,
  resolveApiPathUrl,
  resolveGeneratorApiBase,
} from "../lib/sync-from-api";
import { SITE_DATA_PATH_PREFIX } from "@shared/lib/site-data-lane";
import { ApiMetaSchema, type ApiMeta } from "@shared/types/api-meta";
import { FRONTEND_API_QUERY_DESCRIPTORS } from "../../src/lib/api-query-descriptors";
import { buildHomepageBootstrapDescriptors } from "@shared/lib/homepage-bootstrap-shared";
import { resolveSchemaLike, type SchemaLikeSource } from "@shared/lib/schema-like";
import {
  HOMEPAGE_BOOTSTRAP_VERSION,
  normalizeHomepageBootstrapPayload,
  validateHomepageBootstrapPayloadData,
  type HomepageBootstrapPayload,
  type HomepageBootstrapQuery,
  type HomepageBootstrapQueryId,
} from "../../src/lib/homepage-bootstrap";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "../..");
const OUTPUT_PATH = join(REPO_ROOT, "src/generated/homepage-bootstrap.json");
const CHECK_MODE = process.argv.includes("--check");
const registry = FRONTEND_API_QUERY_DESCRIPTORS;
// App Router duplicates this server-rendered script into the RSC stream, so
// inline only tiny seeds. Larger responses fetch after hydration instead of
// burning the homepage HTML budget in the production Pages release.
const MAX_HOMEPAGE_BOOTSTRAP_BYTES = 5_000;
const MAX_HOMEPAGE_BOOTSTRAP_QUERY_BYTES = 5_000;
const TRUSTED_API_KEY_ORIGINS = new Set(["https://api.pharos.watch"]);
const HOMEPAGE_BOOTSTRAP_GENERATOR_DESCRIPTORS = buildHomepageBootstrapDescriptors(registry);

function emptyPayload(): HomepageBootstrapPayload {
  return {
    version: HOMEPAGE_BOOTSTRAP_VERSION,
    generatedAt: 0,
    source: null,
    queries: {},
  };
}


function parseExistingPayload(): HomepageBootstrapPayload | null {
  if (!existsSync(OUTPUT_PATH)) {
    return null;
  }

  try {
    return normalizeHomepageBootstrapPayload(JSON.parse(readFileSync(OUTPUT_PATH, "utf8")));
  } catch {
    return null;
  }
}

function writePayload(payload: HomepageBootstrapPayload): void {
  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, `${JSON.stringify(payload, null, 2)}\n`);
}

function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function enforcePayloadBudget(payload: HomepageBootstrapPayload): {
  payload: HomepageBootstrapPayload;
  omitted: string[];
} {
  const queries: HomepageBootstrapPayload["queries"] = {};
  const omitted: string[] = [];

  for (const { id } of HOMEPAGE_BOOTSTRAP_GENERATOR_DESCRIPTORS) {
    const query = payload.queries[id];
    if (!query) continue;

    const queryBytes = jsonByteLength(query);
    if (queryBytes > MAX_HOMEPAGE_BOOTSTRAP_QUERY_BYTES) {
      omitted.push(`${id} (${queryBytes} bytes > ${MAX_HOMEPAGE_BOOTSTRAP_QUERY_BYTES})`);
      continue;
    }

    const candidate = { ...payload, queries: { ...queries, [id]: query } };
    const candidateBytes = jsonByteLength(candidate);
    if (candidateBytes > MAX_HOMEPAGE_BOOTSTRAP_BYTES) {
      omitted.push(`${id} (payload ${candidateBytes} bytes > ${MAX_HOMEPAGE_BOOTSTRAP_BYTES})`);
      continue;
    }

    queries[id] = query;
  }

  return {
    payload: { ...payload, queries },
    omitted,
  };
}

function fail(message: string): never {
  console.error(`[generate-homepage-bootstrap] ${message}`);
  process.exit(1);
}

function apiBaseOrigin(apiBase: string): string | null {
  try {
    return new URL(apiBase).origin;
  } catch {
    return null;
  }
}

function sanitizedSource(apiBase: string): string | null {
  return apiBaseOrigin(apiBase);
}

function hasConfiguredApiKey(): boolean {
  return GENERATOR_API_KEY_ENV_NAMES.some((name) => Boolean(process.env[name]?.trim()));
}

function assertSafeApiKeyDestination(apiBase: string): void {
  if (!hasConfiguredApiKey()) return;
  if (isSiteDataApiBase(apiBase)) return;

  const origin = apiBaseOrigin(apiBase);
  if (!origin || !TRUSTED_API_KEY_ORIGINS.has(origin)) {
    fail(
      `refusing to send homepage bootstrap API key to untrusted origin ${origin ?? "<invalid URL>"}; ` +
        `expected one of ${Array.from(TRUSTED_API_KEY_ORIGINS).join(", ")}`,
    );
  }
}

function isSiteDataApiBase(apiBase: string): boolean {
  try {
    return new URL(apiBase).pathname.replace(/\/+$/, "") === SITE_DATA_PATH_PREFIX;
  } catch {
    return false;
  }
}

function isSiteDataRequestUrl(url: string): boolean {
  try {
    return new URL(url).pathname.startsWith(`${SITE_DATA_PATH_PREFIX}/`);
  } catch {
    return false;
  }
}

function fetchHeaders(url: string): Record<string, string> {
  const origin = apiBaseOrigin(url);
  if (!isSiteDataRequestUrl(url) && (!origin || !TRUSTED_API_KEY_ORIGINS.has(origin))) {
    return { Accept: "application/json" };
  }

  return apiFetchHeaders(GENERATOR_API_KEY_ENV_NAMES, { url });
}

function extractMeta(json: unknown, ageHeader: string | null, maxAgeSec: number): {
  data: unknown;
  meta: ApiMeta | null;
} {
  let data = json;
  let meta: ApiMeta | null = null;

  if (json && typeof json === "object" && !Array.isArray(json) && "_meta" in json) {
    const { _meta, ...rest } = json as Record<string, unknown>;
    const parsed = ApiMetaSchema.safeParse(_meta);
    if (parsed.success) {
      meta = parsed.data;
    }
    data = rest;
  }

  if (!meta && ageHeader) {
    const age = Number(ageHeader);
    if (Number.isFinite(age) && age >= 0) {
      meta = {
        updatedAt: Math.floor(Date.now() / 1000) - age,
        ageSeconds: age,
        status: classifyFreshnessRatio(age / maxAgeSec),
      };
    }
  }

  return { data, meta };
}

async function fetchBootstrapQuery(
  apiBase: string,
  id: HomepageBootstrapQueryId,
  path: string,
  maxAgeSec: number,
  schemaSource: SchemaLikeSource<unknown> | undefined,
): Promise<HomepageBootstrapQuery | null> {
  const url = resolveApiPathUrl(apiBase, path);
  try {
    const schema = await resolveSchemaLike(schemaSource);
    const response = await fetch(url, { headers: fetchHeaders(url) });
    if (!response.ok) {
      console.warn(`[generate-homepage-bootstrap] ${path} -> HTTP ${response.status}`);
      return null;
    }

    const json = await response.json();
    const { data, meta } = extractMeta(json, response.headers.get("X-Data-Age"), maxAgeSec);
    const parsed = schema?.safeParse(data);
    if (parsed && !parsed.success) {
      console.warn(`[generate-homepage-bootstrap] ${path} failed schema validation`);
      return null;
    }

    return {
      id,
      path,
      fetchedAt: Date.now(),
      data: parsed ? parsed.data : data,
      meta,
    };
  } catch (error) {
    console.warn(`[generate-homepage-bootstrap] ${path} fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

async function generatePayload(apiBase: string): Promise<HomepageBootstrapPayload> {
  const entries = await Promise.all(
    HOMEPAGE_BOOTSTRAP_GENERATOR_DESCRIPTORS.map(({ id, descriptor }) => {
      const fallbackIntervalMs = (descriptor as { producerIntervalMs?: number }).producerIntervalMs;
      const maxAgeSec = descriptor.metaMaxAgeSec ?? (
        fallbackIntervalMs != null ? fallbackIntervalMs / 1000 : 0
      );
      return fetchBootstrapQuery(
        apiBase,
        id,
        descriptor.path,
        maxAgeSec,
        descriptor.schema,
      ).then((query) => [id, query] as const);
    }),
  );

  const queries: HomepageBootstrapPayload["queries"] = {};
  for (const [id, query] of entries) {
    if (query) {
      queries[id] = query;
    }
  }

  return {
    version: HOMEPAGE_BOOTSTRAP_VERSION,
    generatedAt: Date.now(),
    source: sanitizedSource(apiBase),
    queries,
  };
}

async function validateCheckedInPayload(): Promise<void> {
  const payload = parseExistingPayload();
  if (!payload) {
    fail(`${OUTPUT_PATH} is missing or invalid`);
  }

  const errors = await validateHomepageBootstrapPayloadData(payload);
  if (errors.length > 0) {
    fail(`payload data failed schema validation:\n${errors.join("\n")}`);
  }
}

async function main(): Promise<void> {
  if (CHECK_MODE) {
    await validateCheckedInPayload();
    console.log("[generate-homepage-bootstrap] checked payload shape");
    return;
  }

  const apiBase = resolveGeneratorApiBase();
  if (!apiBase) {
    const existing = parseExistingPayload();
    if (existing) {
      console.log("[generate-homepage-bootstrap] no API base configured; preserving existing payload");
      return;
    }
    writePayload(emptyPayload());
    console.log("[generate-homepage-bootstrap] wrote empty bootstrap payload");
    return;
  }

  assertSafeApiKeyDestination(apiBase);

  const generated = await generatePayload(apiBase);
  if (Object.keys(generated.queries).length === 0) {
    fail("configured API base returned no usable bootstrap queries; refusing to preserve a stale populated payload");
  }

  const { payload, omitted } = enforcePayloadBudget(generated);
  for (const entry of omitted) {
    console.warn(`[generate-homepage-bootstrap] omitted ${entry} from inline payload budget`);
  }

  writePayload(payload);
  console.log(`[generate-homepage-bootstrap] wrote ${Object.keys(payload.queries).length} queries`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
