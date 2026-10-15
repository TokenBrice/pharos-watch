import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
import {
  ACTIVE_STABLECOINS,
  FROZEN_STABLECOINS,
  TRACKED_SOURCE_COINS,
} from "@shared/lib/stablecoins/registry";
import { StablecoinMetaAssetArraySchema } from "@shared/lib/stablecoins/schema";
import {
  SAFETY_SCORE_V9_SCORING_FIELDS,
  type SafetyScoreV9ScoringCatalog,
  type SafetyScoreV9ScoringMeta,
} from "@shared/types/safety-score-v9-scoring-catalog";
import { parseStrictCliArgs } from "../lib/cli-args.mjs";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { fingerprintReportCardRegistryRows } from "../lib/report-card-registry-fingerprint";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUTPUT_PATH = "shared/data/stablecoins/coins.safety-score-v9.generated.json";

export function projectSafetyScoreV9ScoringMeta(coin: SafetyScoreV9ScoringMeta): SafetyScoreV9ScoringMeta {
  return Object.fromEntries(
    SAFETY_SCORE_V9_SCORING_FIELDS
      .filter((field) => Object.prototype.hasOwnProperty.call(coin, field))
      .map((field) => [field, coin[field]]),
  ) as SafetyScoreV9ScoringMeta;
}

export function buildSafetyScoreV9ScoringCatalog(): SafetyScoreV9ScoringCatalog {
  // Validate without replacing the source objects with schema/default output:
  // projection must preserve own-property absence, explicit null and empty values.
  StablecoinMetaAssetArraySchema.parse(TRACKED_SOURCE_COINS);
  return {
    schemaVersion: 1,
    registryFingerprint: fingerprintReportCardRegistryRows({
      activeStablecoins: ACTIVE_STABLECOINS,
      frozenStablecoins: FROZEN_STABLECOINS,
      deadStablecoins: DEAD_STABLECOINS,
    }),
    catalogCount: TRACKED_SOURCE_COINS.length,
    // The canonical registry owns lifecycle predicates, order and suspended-feed stripping.
    activeAssetIds: ACTIVE_STABLECOINS.map((coin) => coin.id),
    rows: ACTIVE_STABLECOINS.map(projectSafetyScoreV9ScoringMeta),
  };
}

export function runSafetyScoreV9ScoringCatalogGenerator(args = process.argv.slice(2)): void {
  const { values } = parseStrictCliArgs(args, { options: { check: { type: "boolean" } } });
  if (values.help) {
    console.log("Usage: generate-safety-score-v9-scoring-catalog.ts [--check]");
    return;
  }
  const catalog = buildSafetyScoreV9ScoringCatalog();
  syncGeneratedArtifacts({
    artifacts: [{ path: resolve(REPO_ROOT, OUTPUT_PATH), contents: `${JSON.stringify(catalog, null, 2)}\n` }],
    check: values.check === true,
    staleMessage: `${OUTPUT_PATH} is stale. Run: npx tsx scripts/maintenance/generate-safety-score-v9-scoring-catalog.ts`,
    currentMessage: `${OUTPUT_PATH}: scoring catalog is current (${catalog.rows.length} active rows).`,
    writtenMessage: `${OUTPUT_PATH}: wrote scoring catalog (${catalog.rows.length} active rows, ${catalog.catalogCount} tracked).`,
  });
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  runSafetyScoreV9ScoringCatalogGenerator();
}
