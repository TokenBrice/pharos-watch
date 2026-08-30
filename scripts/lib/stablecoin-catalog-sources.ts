import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StablecoinMeta } from "@shared/types";
import {
  findDuplicateStablecoinCatalogIds,
  findStablecoinCatalogInvariantIssues,
  STABLECOIN_META_ASSET_FIELD_ORDER,
  STABLECOIN_SOURCE_DOMAIN_FIELDS,
  STABLECOIN_SOURCE_DOMAIN_SCHEMAS,
  STABLECOIN_SOURCE_DOMAIN_VALUES,
  StablecoinMetaAssetArraySchema,
  StablecoinMetaAssetSchema,
  StablecoinMetaCatalogInvariantsSchema,
  StablecoinMetaSourceAssetSchema,
  type StablecoinSourceDomain,
} from "@shared/lib/stablecoins/schema";

export const STABLECOIN_DATA_DIR = "shared/data/stablecoins";
// Retired category shards. They were emptied compatibility shells before deletion;
// the check below only guards against one ever being recreated.
export const RETIRED_STABLECOIN_ASSET_FILES = [
  "usd-major.json",
  "usd-minor.json",
  "non-usd.json",
  "commodity.json",
  "pre-launch.json",
] as const;
export const CANONICAL_ORDER_ASSET_FILE = "canonical-order.json";
export const PER_COIN_SOURCE_DIR = `${STABLECOIN_DATA_DIR}/coins`;
export const STABLECOIN_DOMAIN_SOURCE_DIR = `${STABLECOIN_DATA_DIR}/domains`;
export const GENERATED_PER_COIN_ASSET_FILE = `${STABLECOIN_DATA_DIR}/coins.generated.json`;

export interface StablecoinSourceEntry {
  coin: StablecoinMeta;
  file: string;
  id: string;
  sidecarFiles?: string[];
}

export interface StablecoinDomainSidecarEntry {
  domain: StablecoinSourceDomain;
  fields: Array<keyof StablecoinMeta>;
  file: string;
  id: string;
  patch: Partial<StablecoinMeta>;
}

export interface StablecoinDuplicateIdIssue {
  entries: StablecoinSourceEntry[];
  id: string;
}

export interface CanonicalOrderIssues {
  duplicateIds: string[];
  missingIds: string[];
  unknownIds: string[];
}

export interface SyncGeneratedPerCoinAssetOptions {
  check?: boolean;
  /** Already-validated per-coin entries; loaded from disk when omitted. */
  entries?: StablecoinSourceEntry[];
  rootDir?: string;
}

export interface SyncGeneratedPerCoinAssetResult {
  changed: boolean;
  generatedFile: string;
  perCoinCount: number;
}

function formatSchemaIssues(issues: Array<{ message: string; path?: unknown[] }>): string {
  return issues
    .slice(0, 8)
    .map((issue) => {
      const path = Array.isArray(issue.path) && issue.path.length > 0
        ? issue.path.join(".")
        : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function formatJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJson(relativePath: string, rootDir: string): unknown {
  const absolutePath = resolve(rootDir, relativePath);
  // Repo-owned catalog helpers only read checked-in stablecoin metadata paths.
  return JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
}

function parseAssetArray(relativePath: string, rootDir: string): StablecoinMeta[] {
  const result = StablecoinMetaAssetArraySchema.safeParse(readJson(relativePath, rootDir));
  if (result.success) {
    return result.data as StablecoinMeta[];
  }

  throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
}

function parseSingleAssetValue(value: unknown, label: string): StablecoinMeta {
  const result = StablecoinMetaAssetSchema.safeParse(value);
  if (result.success) {
    return result.data as StablecoinMeta;
  }

  throw new Error(`[stablecoin-assets] Invalid ${label}: ${formatSchemaIssues(result.error.issues)}`);
}

function parseSingleAsset(relativePath: string, rootDir: string): StablecoinMeta {
  const result = StablecoinMetaSourceAssetSchema.safeParse(readJson(relativePath, rootDir));
  if (result.success) {
    return result.data;
  }

  throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
}

function parseDomainSidecar(
  domain: StablecoinSourceDomain,
  relativePath: string,
  rootDir: string,
): StablecoinDomainSidecarEntry {
  const result = STABLECOIN_SOURCE_DOMAIN_SCHEMAS[domain].safeParse(readJson(relativePath, rootDir));
  if (!result.success) {
    throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
  }

  const parsed = result.data as { id: string } & Partial<StablecoinMeta>;
  const fields = STABLECOIN_SOURCE_DOMAIN_FIELDS[domain].filter((field) => hasOwnField(parsed, field));
  const patch = Object.fromEntries(fields.map((field) => [field, parsed[field]])) as Partial<StablecoinMeta>;

  return {
    domain,
    fields: [...fields],
    file: relativePath,
    id: parsed.id,
    patch,
  };
}

function stablecoinIdFromJsonFileName(fileName: string): string {
  return fileName.slice(0, -".json".length);
}

function hasOwnField(value: object, field: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, field);
}

function orderStablecoinMetaFields(meta: StablecoinMeta): StablecoinMeta {
  const source = meta as unknown as Record<string, unknown>;
  const ordered: Record<string, unknown> = {};

  for (const field of STABLECOIN_META_ASSET_FIELD_ORDER) {
    if (hasOwnField(source, field)) {
      ordered[field] = source[field];
    }
  }

  return ordered as unknown as StablecoinMeta;
}

function groupSidecarsById(sidecars: StablecoinDomainSidecarEntry[]): Map<string, StablecoinDomainSidecarEntry[]> {
  const sidecarsById = new Map<string, StablecoinDomainSidecarEntry[]>();

  for (const sidecar of sidecars) {
    const existing = sidecarsById.get(sidecar.id);
    if (existing) {
      existing.push(sidecar);
    } else {
      sidecarsById.set(sidecar.id, [sidecar]);
    }
  }

  return sidecarsById;
}

function findUnsupportedDomainSourceDirs(rootDir: string): string[] {
  const absoluteDir = resolve(rootDir, STABLECOIN_DOMAIN_SOURCE_DIR);
  if (!existsSync(absoluteDir)) {
    return [];
  }

  const supportedDomains = new Set<string>(STABLECOIN_SOURCE_DOMAIN_VALUES);
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !supportedDomains.has(entry.name))
    .map((entry) => `${STABLECOIN_DOMAIN_SOURCE_DIR}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));
}

function mergeStablecoinSidecars(
  entry: StablecoinSourceEntry,
  sidecars: StablecoinDomainSidecarEntry[],
): StablecoinSourceEntry {
  const patch: Record<string, unknown> = {};
  const patchFields = new Set<keyof StablecoinMeta>();
  const sortedSidecars = [...sidecars].sort((a, b) => (
    a.domain.localeCompare(b.domain) || a.file.localeCompare(b.file)
  ));

  for (const sidecar of sortedSidecars) {
    if (sidecar.id !== entry.id) {
      throw new Error(
        `[stablecoin-assets] ${sidecar.file}: sidecar id "${sidecar.id}" must match base id "${entry.id}"`,
      );
    }

    for (const field of STABLECOIN_SOURCE_DOMAIN_FIELDS[sidecar.domain]) {
      if (hasOwnField(entry.coin, field)) {
        throw new Error(
          `[stablecoin-assets] ${sidecar.file}: field "${String(field)}" already exists in ${entry.file}; ` +
          `move every ${sidecar.domain} field completely into the sidecar`,
        );
      }
    }

    for (const field of sidecar.fields) {
      if (patchFields.has(field)) {
        throw new Error(
          `[stablecoin-assets] ${sidecar.file}: field "${String(field)}" ` +
          `is already supplied by another sidecar for ${entry.id}`,
        );
      }

      patchFields.add(field);
      patch[String(field)] = sidecar.patch[field];
    }
  }

  const merged = orderStablecoinMetaFields({
    ...entry.coin,
    ...patch,
  } as StablecoinMeta);
  // Validate every post-merge projection through the full catalog schema,
  // including entries with no sidecars.
  const label = sortedSidecars.length > 0
    ? `${entry.file} + ${sortedSidecars.map((sidecar) => sidecar.file).join(", ")}`
    : entry.file;

  return {
    ...entry,
    coin: parseSingleAssetValue(merged, label),
    ...(sortedSidecars.length > 0
      ? { sidecarFiles: sortedSidecars.map((sidecar) => sidecar.file) }
      : {}),
  };
}

export function findRecreatedRetiredStablecoinAssetFiles(rootDir = process.cwd()): string[] {
  // Repo-owned catalog helpers only probe checked-in stablecoin metadata paths.
  return RETIRED_STABLECOIN_ASSET_FILES
    .map((file) => `${STABLECOIN_DATA_DIR}/${file}`)
    .filter((relativePath) => existsSync(resolve(rootDir, relativePath)));
}

export function loadStablecoinDomainSidecarEntries(rootDir = process.cwd()): StablecoinDomainSidecarEntry[] {
  const unsupportedDomainDirs = findUnsupportedDomainSourceDirs(rootDir);
  if (unsupportedDomainDirs.length > 0) {
    throw new Error(
      `[stablecoin-assets] Unsupported stablecoin sidecar domain directories: ${unsupportedDomainDirs.join(", ")}. ` +
      "Add schema and loader wiring before adding a new domain.",
    );
  }

  return STABLECOIN_SOURCE_DOMAIN_VALUES.flatMap((domain) => {
    const absoluteDir = resolve(rootDir, STABLECOIN_DOMAIN_SOURCE_DIR, domain);
    // Repo-owned catalog helpers only enumerate supported checked-in sidecar domain directories.
    if (!existsSync(absoluteDir)) {
      return [];
    }

    return readdirSync(absoluteDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => {
        const relativePath = `${STABLECOIN_DOMAIN_SOURCE_DIR}/${domain}/${entry.name}`;
        const sidecar = parseDomainSidecar(domain, relativePath, rootDir);
        const expectedId = stablecoinIdFromJsonFileName(entry.name);
        if (sidecar.id !== expectedId) {
          throw new Error(
            `[stablecoin-assets] ${relativePath}: sidecar id "${sidecar.id}" must match file id "${expectedId}"`,
          );
        }
        return sidecar;
      });
  });
}

export function listPerCoinStablecoinSourceFiles(rootDir = process.cwd()): Array<{ id: string; file: string }> {
  const absoluteDir = resolve(rootDir, PER_COIN_SOURCE_DIR);
  // Repo-owned catalog helpers only enumerate the checked-in per-coin source directory.
  if (!existsSync(absoluteDir)) return [];

  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => ({
      id: stablecoinIdFromJsonFileName(entry.name),
      file: `${PER_COIN_SOURCE_DIR}/${entry.name}`,
    }));
}

export function loadPerCoinStablecoinEntries(rootDir = process.cwd()): StablecoinSourceEntry[] {
  const absoluteDir = resolve(rootDir, PER_COIN_SOURCE_DIR);
  const sidecars = loadStablecoinDomainSidecarEntries(rootDir);
  // Repo-owned catalog helpers only probe the checked-in per-coin source directory.
  if (!existsSync(absoluteDir)) {
    if (sidecars.length > 0) {
      throw new Error(
        `${STABLECOIN_DOMAIN_SOURCE_DIR}: sidecar files exist without a ${PER_COIN_SOURCE_DIR} source directory`,
      );
    }
    return [];
  }

  const sidecarsById = groupSidecarsById(sidecars);

  const baseEntries = listPerCoinStablecoinSourceFiles(rootDir).map(({ id: expectedId, file: relativePath }) => {
    // Every base file uses the permissive source schema first; full catalog
    // validation runs after its sidecar fields, if any, are merged back in.
    const coin = parseSingleAsset(relativePath, rootDir);
    if (coin.id !== expectedId) {
      throw new Error(
        `[stablecoin-assets] ${relativePath}: coin id "${coin.id}" must match file id "${expectedId}"`,
      );
    }

    return {
      coin,
      file: relativePath,
      id: coin.id,
    };
  });

  const baseIds = new Set(baseEntries.map((entry) => entry.id));
  for (const sidecar of sidecars) {
    if (!baseIds.has(sidecar.id)) {
      throw new Error(
        `[stablecoin-assets] ${sidecar.file}: no matching base coin found in ${PER_COIN_SOURCE_DIR} for id "${sidecar.id}"`,
      );
    }
  }

  return baseEntries.map((entry) => mergeStablecoinSidecars(entry, sidecarsById.get(entry.id) ?? []));
}

export function loadGeneratedPerCoinCoins(rootDir = process.cwd()): StablecoinMeta[] {
  return parseAssetArray(GENERATED_PER_COIN_ASSET_FILE, rootDir);
}

export function findDuplicateStablecoinIds(entries: StablecoinSourceEntry[]): StablecoinDuplicateIdIssue[] {
  const duplicateIds = new Set(findDuplicateStablecoinCatalogIds(entries));
  const byId = new Map<string, StablecoinSourceEntry[]>();

  for (const entry of entries) {
    if (!duplicateIds.has(entry.id)) {
      continue;
    }

    const existing = byId.get(entry.id);
    if (existing) {
      existing.push(entry);
    } else {
      byId.set(entry.id, [entry]);
    }
  }

  return [...byId.values()]
    .sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))
    .map((group) => ({ entries: group, id: group[0]!.id }));
}

export function formatRecreatedRetiredAssetFileIssue(relativePath: string): string {
  return (
    `${relativePath}: retired legacy category shard must not exist. ` +
    `Edit ${PER_COIN_SOURCE_DIR}/<id>.json and regenerate ${GENERATED_PER_COIN_ASSET_FILE} instead.`
  );
}

export function findCanonicalOrderIssues(
  canonicalOrder: string[],
  entries: StablecoinSourceEntry[],
): CanonicalOrderIssues {
  const issues = findStablecoinCatalogInvariantIssues({
    canonicalOrder,
    stablecoins: entries,
  });

  return {
    duplicateIds: [...issues.duplicateCanonicalOrderIds].sort((a, b) => a.localeCompare(b)),
    missingIds: [...issues.missingCanonicalOrderIds].sort((a, b) => a.localeCompare(b)),
    unknownIds: [...issues.unknownCanonicalOrderIds].sort((a, b) => a.localeCompare(b)),
  };
}

export function buildGeneratedPerCoinAsset(entries: StablecoinSourceEntry[]): StablecoinMeta[] {
  return [...entries]
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => entry.coin);
}

export function syncGeneratedPerCoinAsset({
  check = false,
  entries,
  rootDir = process.cwd(),
}: SyncGeneratedPerCoinAssetOptions = {}): SyncGeneratedPerCoinAssetResult {
  const perCoinEntries = entries ?? loadPerCoinStablecoinEntries(rootDir);
  const duplicateIssues = findDuplicateStablecoinIds(perCoinEntries);
  if (duplicateIssues.length > 0) {
    const details = duplicateIssues
      .map((issue) => (
        `"${issue.id}" in ${issue.entries.map((entry) => entry.file).join(", ")}`
      ))
      .join("; ");
    throw new Error(`Duplicate per-coin stablecoin IDs detected while generating per-coin asset: ${details}`);
  }

  // `perCoinEntries` already came out of the per-record catalog schema, so only
  // the cross-record invariants still need to run over the projection.
  const projection = buildGeneratedPerCoinAsset(perCoinEntries);
  const catalogResult = StablecoinMetaCatalogInvariantsSchema.safeParse(projection);
  if (!catalogResult.success) {
    throw new Error(
      `[stablecoin-assets] Generated ${GENERATED_PER_COIN_ASSET_FILE} is invalid: ` +
      formatSchemaIssues(catalogResult.error.issues),
    );
  }
  const expected = formatJson(projection);
  const absoluteGeneratedPath = resolve(rootDir, GENERATED_PER_COIN_ASSET_FILE);
  // Repo-owned catalog helpers only check the checked-in generated aggregate path.
  const current = existsSync(absoluteGeneratedPath)
    ? formatJson(readJson(GENERATED_PER_COIN_ASSET_FILE, rootDir))
    : "";

  if (check) {
    if (current !== expected) {
      throw new Error(
        `${GENERATED_PER_COIN_ASSET_FILE} is stale. Run: tsx scripts/maintenance/generate-stablecoin-per-coin-asset.ts`,
      );
    }

    return {
      changed: false,
      generatedFile: GENERATED_PER_COIN_ASSET_FILE,
      perCoinCount: perCoinEntries.length,
    };
  }

  const changed = current !== expected;
  if (changed) {
    // Repo-owned catalog helpers only write the checked-in generated aggregate path.
    mkdirSync(dirname(absoluteGeneratedPath), { recursive: true });
    // Repo-owned catalog helpers only write the checked-in generated aggregate path.
    writeFileSync(absoluteGeneratedPath, expected, "utf8");
  }

  return {
    changed,
    generatedFile: GENERATED_PER_COIN_ASSET_FILE,
    perCoinCount: perCoinEntries.length,
  };
}
