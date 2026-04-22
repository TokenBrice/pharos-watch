import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { StablecoinMeta } from "../../shared/types";
import {
  StablecoinMetaAssetArraySchema,
  StablecoinMetaAssetSchema,
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
export const GENERATED_PER_COIN_ASSET_FILE = `${STABLECOIN_DATA_DIR}/coins.generated.json`;

export type StablecoinLegacyAssetFile = typeof LEGACY_STABLECOIN_ASSET_FILES[number];
export type StablecoinCatalogSourceKind = "legacy" | "per-coin";

export interface StablecoinSourceEntry {
  coin: StablecoinMeta;
  file: string;
  id: string;
  legacyShard?: StablecoinLegacyAssetFile;
  sourceKind: StablecoinCatalogSourceKind;
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
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
}

function parseAssetArray(relativePath: string, rootDir: string): StablecoinMeta[] {
  const result = StablecoinMetaAssetArraySchema.safeParse(readJson(relativePath, rootDir));
  if (result.success) {
    return result.data as StablecoinMeta[];
  }

  throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
}

function parseSingleAsset(relativePath: string, rootDir: string): StablecoinMeta {
  const result = StablecoinMetaAssetSchema.safeParse(readJson(relativePath, rootDir));
  if (result.success) {
    return result.data as StablecoinMeta;
  }

  throw new Error(`[stablecoin-assets] Invalid ${relativePath}: ${formatSchemaIssues(result.error.issues)}`);
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

export function loadPerCoinStablecoinEntries(rootDir = process.cwd()): StablecoinSourceEntry[] {
  const absoluteDir = resolve(rootDir, PER_COIN_SOURCE_DIR);
  // Repo-owned catalog helpers only probe the checked-in per-coin source directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(absoluteDir)) {
    return [];
  }

  // Repo-owned catalog helpers only enumerate the checked-in per-coin source directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return readdirSync(absoluteDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => {
      const relativePath = `${PER_COIN_SOURCE_DIR}/${entry.name}`;
      const coin = parseSingleAsset(relativePath, rootDir);
      return {
        coin,
        file: relativePath,
        id: coin.id,
        sourceKind: "per-coin" as const,
      };
    });
}

export function loadGeneratedPerCoinCoins(rootDir = process.cwd()): StablecoinMeta[] {
  return parseAssetArray(GENERATED_PER_COIN_ASSET_FILE, rootDir);
}

export function findDuplicateStablecoinIds(entries: StablecoinSourceEntry[]): StablecoinDuplicateIdIssue[] {
  const byId = new Map<string, StablecoinSourceEntry[]>();

  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing) {
      existing.push(entry);
    } else {
      byId.set(entry.id, [entry]);
    }
  }

  return [...byId.values()]
    .filter((group) => group.length > 1)
    .sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))
    .map((group) => ({ entries: group, id: group[0]!.id }));
}

export function findCanonicalOrderIssues(
  canonicalOrder: string[],
  entries: StablecoinSourceEntry[],
): CanonicalOrderIssues {
  const duplicateCanonicalIds: string[] = [];
  const seenCanonical = new Set<string>();

  for (const id of canonicalOrder) {
    if (seenCanonical.has(id)) {
      duplicateCanonicalIds.push(id);
      continue;
    }
    seenCanonical.add(id);
  }

  const knownIds = new Set(entries.map((entry) => entry.id));
  const unknownIds = canonicalOrder.filter((id) => !knownIds.has(id));
  const missingIds = [...new Set(
    entries
      .map((entry) => entry.id)
      .filter((id) => !seenCanonical.has(id)),
  )].sort((a, b) => a.localeCompare(b));

  return {
    duplicateIds: [...new Set(duplicateCanonicalIds)].sort((a, b) => a.localeCompare(b)),
    missingIds,
    unknownIds: [...new Set(unknownIds)].sort((a, b) => a.localeCompare(b)),
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
  const legacyEntries = loadLegacyStablecoinEntries(rootDir);
  const perCoinEntries = loadPerCoinStablecoinEntries(rootDir);
  const duplicateIssues = findDuplicateStablecoinIds([...legacyEntries, ...perCoinEntries]);
  if (duplicateIssues.length > 0) {
    const details = duplicateIssues
      .map((issue) => (
        `"${issue.id}" in ${issue.entries.map((entry) => entry.file).join(", ")}`
      ))
      .join("; ");
    throw new Error(`Duplicate stablecoin IDs detected while generating per-coin asset: ${details}`);
  }

  const expected = formatJson(buildGeneratedPerCoinAsset(perCoinEntries));
  const absoluteGeneratedPath = resolve(rootDir, GENERATED_PER_COIN_ASSET_FILE);
  // Repo-owned catalog helpers only check the checked-in generated aggregate path.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  const current = existsSync(absoluteGeneratedPath)
    ? formatJson(loadGeneratedPerCoinCoins(rootDir))
    : "";

  if (check) {
    if (current !== expected) {
      throw new Error(
        `${GENERATED_PER_COIN_ASSET_FILE} is stale. Run: tsx scripts/generate-stablecoin-per-coin-asset.ts`,
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
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    mkdirSync(dirname(absoluteGeneratedPath), { recursive: true });
    // Repo-owned catalog helpers only write the checked-in generated aggregate path.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    writeFileSync(absoluteGeneratedPath, expected, "utf8");
  }

  return {
    changed,
    generatedFile: GENERATED_PER_COIN_ASSET_FILE,
    perCoinCount: perCoinEntries.length,
  };
}
