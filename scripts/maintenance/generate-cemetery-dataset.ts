import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sortCemeteryCoins } from "@shared/lib/cemetery";
import { CAUSE_META } from "@shared/lib/cause-of-death";
import { buildFrozenCemeteryProjection, CEMETERY_ENTRIES, CEMETERY_RECORDED_AT_DESCRIPTION, type CemeteryEntry } from "@shared/lib/cemetery-merged";
import { SITE_ORIGIN } from "@shared/lib/runtime-origins";
import { sha256Hex } from "@shared/lib/sha256";
import { stableJsonStringifyV1 } from "@shared/lib/stable-json";
import { buildStablecoinUrl } from "@shared/lib/urls";
import type { DeadStablecoin } from "@shared/types";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types/stablecoin-taxonomy";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_REPO_PATH = "shared/lib/cemetery-merged.ts";
const SOURCE_FILE_PATH = join(__dirname, "../../shared/lib/cemetery-merged.ts");
const SOURCE_DATA = [
  {
    repoPath: "shared/data/dead-stablecoins.json",
    role: "Curated dead-stablecoin metadata.",
    readContent: () => readFileSync(join(__dirname, "../../shared/data/dead-stablecoins.json"), "utf8"),
  },
  {
    repoPath: "shared/lib/cemetery-merged.ts#frozenCemeteryProjection",
    role: "Canonical frozen tracked-stablecoin projection merged into cemetery rows.",
    readContent: () => stableJsonStringifyV1(buildFrozenCemeteryProjection()),
  },
  {
    repoPath: "shared/lib/cause-of-death.ts#causeLabels",
    role: "Canonical cause labels embedded in exported rows.",
    readContent: () => stableJsonStringifyV1(
      Object.fromEntries(Object.entries(CAUSE_META).map(([cause, meta]) => [cause, meta.label])),
    ),
  },
] as const;
const OUTPUT_DIR = join(__dirname, "../../public/datasets");
const JSON_OUTPUT = join(OUTPUT_DIR, "stablecoin-cemetery.json");
const CSV_OUTPUT = join(OUTPUT_DIR, "stablecoin-cemetery.csv");
const CHECK_MODE = process.argv.includes("--check");

interface CemeteryDatasetSource {
  path: string;
  checksum: string;
  role: string;
}

interface CemeteryDatasetRow {
  id: string;
  name: string;
  symbol: string;
  llamaId: string | null;
  logoUrl: string | null;
  pegCurrency: string;
  causeOfDeath: DeadStablecoin["causeOfDeath"];
  causeLabel: string;
  deathDate: string;
  deathDatePrecision: "day" | "month" | "year" | "unknown";
  peakMcapUsd: number | null;
  epitaph: string | null;
  obituary: string;
  sourceUrl: string;
  sourceLabel: string;
  contracts: { chain: string; address: string }[];
  archivedDataAvailable: boolean;
  pharosUrl: string;
  mechanismArchetype: NonNullable<DeadStablecoin["mechanismArchetype"]> | null;
  recordedAt: string | null;
}

const CSV_COLUMNS = [
  "id",
  "name",
  "symbol",
  "llamaId",
  "logoUrl",
  "pegCurrency",
  "causeOfDeath",
  "causeLabel",
  "deathDate",
  "deathDatePrecision",
  "peakMcapUsd",
  "epitaph",
  "obituary",
  "sourceUrl",
  "sourceLabel",
  "archivedDataAvailable",
  "contracts",
  "pharosUrl",
  "mechanismArchetype",
  "recordedAt",
] as const satisfies readonly (keyof CemeteryDatasetRow)[];

function getDeathDatePrecision(deathDate: string): CemeteryDatasetRow["deathDatePrecision"] {
  if (/^\d{4}-\d{2}-\d{2}$/.test(deathDate)) return "day";
  if (/^\d{4}-\d{2}$/.test(deathDate)) return "month";
  if (/^\d{4}$/.test(deathDate)) return "year";
  return "unknown";
}

function getLogoUrl(logo?: string): string | null {
  if (!logo) return null;
  return logo.startsWith("/")
    ? `${SITE_ORIGIN}${logo}`
    : `${SITE_ORIGIN}/logos/cemetery/${logo}`;
}

function coinToRow(coin: CemeteryEntry): CemeteryDatasetRow {
  const archivedDataAvailable = coin.archivedDataAvailable === true;
  return {
    id: coin.id,
    name: coin.name,
    symbol: coin.symbol,
    llamaId: coin.llamaId ?? null,
    logoUrl: getLogoUrl(coin.logo),
    pegCurrency: coin.pegCurrency,
    causeOfDeath: coin.causeOfDeath,
    causeLabel: CAUSE_META[coin.causeOfDeath].label,
    deathDate: coin.deathDate,
    deathDatePrecision: getDeathDatePrecision(coin.deathDate),
    peakMcapUsd: coin.peakMcap ?? null,
    epitaph: coin.epitaph ?? null,
    obituary: coin.obituary,
    sourceUrl: coin.sourceUrl,
    sourceLabel: coin.sourceLabel,
    archivedDataAvailable,
    contracts: coin.contracts ?? [],
    pharosUrl: archivedDataAvailable
      ? `${SITE_ORIGIN}${buildStablecoinUrl(coin.id)}`
      : `${SITE_ORIGIN}/cemetery/#${coin.id}`,
    mechanismArchetype: coin.mechanismArchetype ?? null,
    recordedAt: coin.recordedAt ?? null,
  };
}

function assertUniqueRowIds(rows: CemeteryDatasetRow[]): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) {
      throw new Error(`Duplicate cemetery dataset id: ${row.id}`);
    }
    seen.add(row.id);
  }
}

function normalizeCsvText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatCsvValue(value: unknown): string {
  if (value == null) {
    return "";
  }

  const raw = Array.isArray(value)
    ? value.map((entry) => `${entry.chain}:${entry.address}`).join("; ")
    : String(value);
  const text = normalizeCsvText(raw);

  if (!/[",\n\r]/.test(text)) {
    return text;
  }

  return `"${text.replaceAll("\"", "\"\"")}"`;
}

function renderCsv(rows: CemeteryDatasetRow[]): string {
  const lines = [
    CSV_COLUMNS.join(","),
    ...rows.map((row) => CSV_COLUMNS.map((column) => formatCsvValue(row[column])).join(",")),
  ];

  return `${lines.join("\n")}\n`;
}

function getSourceDataProvenance(): CemeteryDatasetSource[] {
  return SOURCE_DATA.map(({ repoPath, readContent, role }) => ({
    path: repoPath,
    checksum: `sha256:${sha256Hex(readContent())}`,
    role,
  }));
}

function getCombinedSourceChecksum(sources: CemeteryDatasetSource[]): string {
  const checksumInput = [
    {
      path: SOURCE_REPO_PATH,
      checksum: `sha256:${sha256Hex(readFileSync(SOURCE_FILE_PATH, "utf8"))}`,
    },
    ...sources.map(({ path, checksum }) => ({ path, checksum })),
  ];
  return `sha256:${sha256Hex(JSON.stringify(checksumInput))}`;
}

function renderJson(rows: CemeteryDatasetRow[]): string {
  const sourceData = getSourceDataProvenance();
  // YYYY-MM-DD strings order chronologically as text.
  const updatedAt = rows.reduce<string | null>(
    (latest, row) => (row.recordedAt !== null && (latest === null || row.recordedAt > latest) ? row.recordedAt : latest),
    null,
  );

  return `${JSON.stringify({
    schemaVersion: "1.1",
    name: "Pharos Stablecoin Cemetery Dataset",
    description:
      "Curated dataset of defunct, depegged, discontinued, and abandoned stablecoins documented by Pharos.",
    license: "MIT",
    canonicalUrl: `${SITE_ORIGIN}/cemetery/`,
    jsonUrl: `${SITE_ORIGIN}/datasets/stablecoin-cemetery.json`,
    csvUrl: `${SITE_ORIGIN}/datasets/stablecoin-cemetery.csv`,
    sourceDataPath: SOURCE_REPO_PATH,
    sourceChecksum: getCombinedSourceChecksum(sourceData),
    sourceData,
    // Mirrors sortCemeteryCoins (shared/lib/cemetery.ts); change both together.
    recordsOrderedBy:
      "deathDate descending by year, month, then day (a month-precision date sorts as the start of its month, "
      + "after that month's day-precision rows; an unparseable date sorts last), then peakMcapUsd descending "
      + "(rows without a peak after rows with one), then symbol ascending, then id ascending "
      + "(symbol and id compared by UTF-16 code unit)",
    rowCount: rows.length,
    updatedAt,
    limitations: [
      "Death dates are month-level unless a row explicitly uses a day-level date.",
      "Peak market capitalization is optional and may be absent when no reliable public figure was curated.",
      "Each row includes one primary source link; the export is an incident index, not a complete bibliography.",
    ],
    datasetFields: {
      updatedAt:
        "Latest recordedAt across all rows (UTC YYYY-MM-DD): when the newest record entered Pharos. "
        + "Tracks documentation, not deaths; null when no row carries a recordedAt.",
    },
    fields: {
      id: "Stable export row identifier from curated dead-stablecoin metadata.",
      name: "Stablecoin or protocol display name.",
      symbol: "Primary stablecoin ticker or display symbol.",
      llamaId: "Optional DefiLlama stablecoin identifier when historically available.",
      logoUrl: "Optional Pharos-hosted cemetery logo URL.",
      pegCurrency: "Target peg currency or asset.",
      causeOfDeath: "Machine-readable Pharos cause category.",
      causeLabel: "Human-readable Pharos cause category.",
      deathDate: "Month or date when the stablecoin failed, was discontinued, or entered terminal decline.",
      deathDatePrecision: "Precision of deathDate: day, month, year, or unknown.",
      peakMcapUsd: "Approximate peak market capitalization in USD when known.",
      epitaph: "Short editorial summary used by the Pharos Cemetery UI.",
      obituary: "Curated explanation of the failure mode.",
      sourceUrl: "Primary source URL for the cemetery entry.",
      sourceLabel: "Primary source label for the cemetery entry.",
      archivedDataAvailable: "True when Pharos preserves a frozen detail page with archived data for this entry.",
      contracts: "Known historical token contracts when available.",
      pharosUrl: "Canonical Pharos URL: the frozen detail page when archived data is available, otherwise the cemetery anchor.",
      mechanismArchetype:
        `Pharos mechanism archetype: how the stablecoin was designed to hold its peg (${MECHANISM_ARCHETYPE_VALUES.join(", ")}). `
        + "Independent of causeOfDeath; null when not yet classified.",
      recordedAt: CEMETERY_RECORDED_AT_DESCRIPTION,
    },
    rows,
  }, null, 2)}\n`;
}

export function buildCemeteryDataset(entries: CemeteryEntry[] = CEMETERY_ENTRIES): { json: string; csv: string } {
  const rows = sortCemeteryCoins(entries, "newest").map(coinToRow);
  assertUniqueRowIds(rows);
  return { json: renderJson(rows), csv: renderCsv(rows) };
}

function main() {
  const { json: nextJson, csv: nextCsv } = buildCemeteryDataset();

  syncGeneratedArtifacts({
    artifacts: [
      { path: JSON_OUTPUT, contents: nextJson },
      { path: CSV_OUTPUT, contents: nextCsv },
    ],
    check: CHECK_MODE,
    staleMessage: "Cemetery dataset exports are out of date. Run `tsx scripts/maintenance/generate-cemetery-dataset.ts`.",
    currentMessage: "Cemetery dataset exports are current",
    writtenMessage: `Generated cemetery dataset exports for ${CEMETERY_ENTRIES.length} stablecoins`,
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
