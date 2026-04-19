import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CAUSE_META, DEAD_STABLECOINS } from "../shared/lib/dead-stablecoins";
import { SITE_ORIGIN } from "../shared/lib/runtime-origins";
import type { DeadStablecoin } from "../shared/types";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DATA_PATH = join(__dirname, "../shared/data/dead-stablecoins.json");
const SOURCE_REPO_PATH = "shared/data/dead-stablecoins.json";
const OUTPUT_DIR = join(__dirname, "../public/datasets");
const JSON_OUTPUT = join(OUTPUT_DIR, "stablecoin-cemetery.json");
const CSV_OUTPUT = join(OUTPUT_DIR, "stablecoin-cemetery.csv");
const CHECK_MODE = process.argv.includes("--check");

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
  pharosUrl: string;
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
  "contracts",
  "pharosUrl",
] as const satisfies readonly (keyof CemeteryDatasetRow)[];

function getDeathMonthValue(deathDate: string): number {
  const [yearPart, monthPart] = deathDate.split("-");
  const year = Number(yearPart);
  const month = Number(monthPart ?? "1");

  if (!Number.isFinite(year) || !Number.isFinite(month)) {
    return 0;
  }

  return year * 12 + Math.max(0, month - 1);
}

function sortByNewestDeath(coins: DeadStablecoin[]): DeadStablecoin[] {
  return [...coins].sort((left, right) => {
    const deathDiff = getDeathMonthValue(right.deathDate) - getDeathMonthValue(left.deathDate);
    if (deathDiff !== 0) {
      return deathDiff;
    }

    const peakDiff = (right.peakMcap ?? 0) - (left.peakMcap ?? 0);
    if (peakDiff !== 0) {
      return peakDiff;
    }

    return left.symbol.localeCompare(right.symbol);
  });
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return slug || "unknown";
}

function getDeathDatePrecision(deathDate: string): CemeteryDatasetRow["deathDatePrecision"] {
  if (/^\d{4}-\d{2}-\d{2}$/.test(deathDate)) return "day";
  if (/^\d{4}-\d{2}$/.test(deathDate)) return "month";
  if (/^\d{4}$/.test(deathDate)) return "year";
  return "unknown";
}

function coinToRow(coin: DeadStablecoin): CemeteryDatasetRow {
  return {
    id: `${slugify(coin.symbol)}-${slugify(coin.name)}-${coin.deathDate}`,
    name: coin.name,
    symbol: coin.symbol,
    llamaId: coin.llamaId ?? null,
    logoUrl: coin.logo ? `${SITE_ORIGIN}/logos/cemetery/${coin.logo}` : null,
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
    contracts: coin.contracts ?? [],
    pharosUrl: `${SITE_ORIGIN}/cemetery/`,
  };
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

function renderJson(rows: CemeteryDatasetRow[]): string {
  const sourceData = readFileSync(SOURCE_DATA_PATH, "utf8");

  return `${JSON.stringify({
    schemaVersion: "1.0",
    name: "Pharos Stablecoin Cemetery Dataset",
    description:
      "Curated dataset of defunct, depegged, discontinued, and abandoned stablecoins documented by Pharos.",
    license: "MIT",
    canonicalUrl: `${SITE_ORIGIN}/cemetery/`,
    jsonUrl: `${SITE_ORIGIN}/datasets/stablecoin-cemetery.json`,
    csvUrl: `${SITE_ORIGIN}/datasets/stablecoin-cemetery.csv`,
    sourceDataPath: SOURCE_REPO_PATH,
    sourceChecksum: `sha256:${createHash("sha256").update(sourceData).digest("hex")}`,
    recordsOrderedBy: "deathDate descending, then peakMcapUsd descending, then symbol ascending",
    rowCount: rows.length,
    limitations: [
      "Death dates are month-level unless a row explicitly uses a day-level date.",
      "Peak market capitalization is optional and may be absent when no reliable public figure was curated.",
      "Each row includes one primary source link; the export is an incident index, not a complete bibliography.",
    ],
    fields: {
      id: "Stable export row identifier derived from symbol, name, and deathDate.",
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
      contracts: "Known historical token contracts when available.",
      pharosUrl: "Canonical Pharos Cemetery page for the dataset.",
    },
    rows,
  }, null, 2)}\n`;
}

const rows = sortByNewestDeath(DEAD_STABLECOINS).map(coinToRow);
const nextJson = renderJson(rows);
const nextCsv = renderCsv(rows);

if (CHECK_MODE) {
  const currentJson = existsSync(JSON_OUTPUT) ? readFileSync(JSON_OUTPUT, "utf8") : "";
  const currentCsv = existsSync(CSV_OUTPUT) ? readFileSync(CSV_OUTPUT, "utf8") : "";

  if (currentJson !== nextJson || currentCsv !== nextCsv) {
    console.error("Cemetery dataset exports are out of date. Run `tsx scripts/generate-cemetery-dataset.ts`.");
    process.exit(1);
  }

  console.log("Cemetery dataset exports are current");
} else {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(JSON_OUTPUT, nextJson, "utf8");
  writeFileSync(CSV_OUTPUT, nextCsv, "utf8");
  console.log(`Generated cemetery dataset exports for ${rows.length} stablecoins`);
}
