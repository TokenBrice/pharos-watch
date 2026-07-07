import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StablecoinMeta } from "../../shared/types";
import {
  findDuplicateStablecoinCatalogIds,
  findStablecoinCatalogInvariantIssues,
  STABLECOIN_META_ASSET_FIELD_ORDER,
  STABLECOIN_SOURCE_DOMAIN_VALUES,
  StablecoinMetaAssetArraySchema,
  StablecoinMetaAssetSchema,
  StablecoinReservesSidecarSchema,
  type StablecoinSourceDomain,
} from "../../shared/lib/stablecoins/schema";

export const STABLECOIN_DATA_DIR = "shared/data/stablecoins";
export const LEGACY_STABLECOIN_ASSET_FILES = [
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
export const STABLECOIN_SOURCE_DOMAINS = [...STABLECOIN_SOURCE_DOMAIN_VALUES];

export type StablecoinLegacyAssetFile = typeof LEGACY_STABLECOIN_ASSET_FILES[number];
export type StablecoinCatalogSourceKind = "legacy" | "per-coin";

export interface StablecoinSourceEntry {
  coin: StablecoinMeta;
  file: string;
  id: string;
  legacyShard?: StablecoinLegacyAssetFile;
  sidecarFiles?: string[];
  sourceKind: StablecoinCatalogSourceKind;
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

export interface StablecoinLegacyShardEntriesIssue {
  count: number;
  entries: StablecoinSourceEntry[];
  file: string;
  legacyShard: StablecoinLegacyAssetFile;
}

export interface CanonicalOrderIssues {
  duplicateIds: string[];
  missingIds: string[];
  unknownIds: string[];
}

export interface SyncGeneratedPerCoinAssetOptions {
  check?: boolean;
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
  return parseSingleAssetValue(readJson(relativePath, rootDir), relativePath);
}

function parseGeneratedPerCoinAsset(value: unknown): StablecoinMeta[] {
  const result = StablecoinMetaAssetArraySchema.safeParse(value);
  if (result.success) {
    return result.data as StablecoinMeta[];
  }

  throw new Error(
    `[stablecoin-assets] Generated ${GENERATED_PER_COIN_ASSET_FILE} is invalid: ` +
    formatSchemaIssues(result.error.issues),
  );
}

function parseReservesSidecar(relativePath: string, rootDir: string): StablecoinDomainSidecarEntry {
  const result = StablecoinReservesSidecarSchema.safeParse(readJson(relativePath, rootDir));
  if (!result.success) {
    throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
  }

  return {
    domain: "reserves",
    fields: ["reserves"],
    file: relativePath,
    id: result.data.id,
    patch: {
      reserves: result.data.reserves,
    },
  };
}

function parseDomainSidecar(
  domain: StablecoinSourceDomain,
  relativePath: string,
  rootDir: string,
): StablecoinDomainSidecarEntry {
  switch (domain) {
    case "reserves":
      return parseReservesSidecar(relativePath, rootDir);
  }
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

  const supportedDomains = new Set<string>(STABLECOIN_SOURCE_DOMAINS);
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !supportedDomains.has(entry.name))
    .map((entry) => `${STABLECOIN_DOMAIN_SOURCE_DIR}/${entry.name}`)
    .sort((a, b) => a.localeCompare(b));
}

function mergeStablecoinSidecars(
  entry: StablecoinSourceEntry,
  sidecars: StablecoinDomainSidecarEntry[],
): StablecoinSourceEntry {
  if (sidecars.length === 0) {
    return entry;
  }

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

    for (const field of sidecar.fields) {
      if (hasOwnField(entry.coin, field)) {
        throw new Error(
          `[stablecoin-assets] ${sidecar.file}: field "${String(field)}" already exists in ${entry.file}; ` +
          "move the field completely into the sidecar or remove the sidecar copy",
        );
      }

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
  const label = `${entry.file} + ${sortedSidecars.map((sidecar) => sidecar.file).join(", ")}`;

  return {
    ...entry,
    coin: parseSingleAssetValue(merged, label),
    sidecarFiles: sortedSidecars.map((sidecar) => sidecar.file),
  };
}

export function loadLegacyStablecoinEntries(rootDir = process.cwd()): StablecoinSourceEntry[] {
  return LEGACY_STABLECOIN_ASSET_FILES.flatMap((file) => {
    const relativePath = `${STABLECOIN_DATA_DIR}/${file}`;
    return parseAssetArray(relativePath, rootDir).map((coin) => ({
      coin,
      file: relativePath,
      id: coin.id,
      legacyShard: file,
      sourceKind: "legacy" as const,
    }));
  });
}

export function loadStablecoinDomainSidecarEntries(rootDir = process.cwd()): StablecoinDomainSidecarEntry[] {
  const unsupportedDomainDirs = findUnsupportedDomainSourceDirs(rootDir);
  if (unsupportedDomainDirs.length > 0) {
    throw new Error(
      `[stablecoin-assets] Unsupported stablecoin sidecar domain directories: ${unsupportedDomainDirs.join(", ")}. ` +
      "Add schema and loader wiring before adding a new domain.",
    );
  }

  return STABLECOIN_SOURCE_DOMAINS.flatMap((domain) => {
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

  // Repo-owned catalog helpers only enumerate the checked-in per-coin source directory.
  const baseEntries = readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const relativePath = `${PER_COIN_SOURCE_DIR}/${entry.name}`;
      const coin = parseSingleAsset(relativePath, rootDir);
      const expectedId = stablecoinIdFromJsonFileName(entry.name);
      if (coin.id !== expectedId) {
        throw new Error(
          `[stablecoin-assets] ${relativePath}: coin id "${coin.id}" must match file id "${expectedId}"`,
        );
      }

      return {
        coin,
        file: relativePath,
        id: coin.id,
        sourceKind: "per-coin" as const,
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

  const sidecarsById = groupSidecarsById(sidecars);
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

export function findNonEmptyLegacyStablecoinShards(
  entries: StablecoinSourceEntry[],
): StablecoinLegacyShardEntriesIssue[] {
  const byShard = new Map<StablecoinLegacyAssetFile, StablecoinSourceEntry[]>();

  for (const entry of entries) {
    if (entry.sourceKind !== "legacy" || !entry.legacyShard) {
      continue;
    }

    const existing = byShard.get(entry.legacyShard);
    if (existing) {
      existing.push(entry);
    } else {
      byShard.set(entry.legacyShard, [entry]);
    }
  }

  return [...byShard.entries()]
    .map(([legacyShard, shardEntries]) => ({
      count: shardEntries.length,
      entries: shardEntries,
      file: `${STABLECOIN_DATA_DIR}/${legacyShard}`,
      legacyShard,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function formatLegacyShardEntriesIssue(issue: StablecoinLegacyShardEntriesIssue): string {
  const sampleIds = issue.entries
    .slice(0, 8)
    .map((entry) => entry.id)
    .join(", ");
  const extraCount = issue.count - 8;
  const idDetails = sampleIds
    ? ` IDs: ${sampleIds}${extraCount > 0 ? `, and ${extraCount} more` : ""}.`
    : "";

  return (
    `${issue.file}: legacy stablecoin shard contains ${issue.count} ` +
    `${issue.count === 1 ? "entry" : "entries"}.${idDetails} ` +
    `Legacy shards are read-only compatibility shells; edit ${PER_COIN_SOURCE_DIR}/<id>.json ` +
    `and regenerate ${GENERATED_PER_COIN_ASSET_FILE} instead.`
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
  return entries
    .filter((entry) => entry.sourceKind === "per-coin")
    .sort((a, b) => a.file.localeCompare(b.file))
    .map((entry) => entry.coin);
}

export function syncGeneratedPerCoinAsset({
  check = false,
  rootDir = process.cwd(),
}: SyncGeneratedPerCoinAssetOptions = {}): SyncGeneratedPerCoinAssetResult {
  const perCoinEntries = loadPerCoinStablecoinEntries(rootDir);
  const duplicateIssues = findDuplicateStablecoinIds(perCoinEntries);
  if (duplicateIssues.length > 0) {
    const details = duplicateIssues
      .map((issue) => (
        `"${issue.id}" in ${issue.entries.map((entry) => entry.file).join(", ")}`
      ))
      .join("; ");
    throw new Error(`Duplicate per-coin stablecoin IDs detected while generating per-coin asset: ${details}`);
  }

  const expected = formatJson(parseGeneratedPerCoinAsset(buildGeneratedPerCoinAsset(perCoinEntries)));
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
