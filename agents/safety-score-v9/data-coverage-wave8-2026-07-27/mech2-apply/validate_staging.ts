import { readFileSync } from "node:fs";
import { MechanismReviewOverlaySchema } from "../../../../worker/src/lib/safety-score-v9-extension-mechanism.ts";

const ARCHETYPE_METRICS: Record<string, string[]> = {
  cdp: ["collateralizationRatio", "liquidationCapacityRatio"],
  "synthetic-delta-neutral": ["hedgeCoverageRatio", "marginBufferPct", "lossAbsorptionShare"],
  algorithmic: ["exogenousBackingShare", "reflexiveBackingShare", "contractionCapacityRatio"],
  "rwa-credit-fund": ["weightedAverageMaturityDays", "valuationCadenceDays"],
  "fiat-cash": [],
  tbill: [],
};
const ARCHETYPE_COMPONENTS: Record<string, string[]> = {
  cdp: ["collateralizationParameters", "liquidationMechanics", "backstop", "branchIsolation", "shutdownAndBadDebt", "structuralRedemption"],
  "synthetic-delta-neutral": ["venueAndCustody", "hedgeReconciliation", "fundingBasisStress", "marginAndLiquidation", "unwindCapacity", "lossAbsorption"],
  algorithmic: ["contractionCapacity", "confidenceAndIncentives", "oracleAndControlAssumptions", "emergencyRecovery", "lossRecovery"],
  "rwa-credit-fund": ["creditQuality", "seniority", "legalEnforceability", "valuationCadence", "maturityAndLiquidity", "custody", "recovery"],
  "fiat-cash": ["claimAndSegregation", "custodyContinuity", "assuranceAndReconciliation"],
  tbill: ["fundClaimAndSeniority", "navValuation", "durationAndLiquidity", "lossRecoveryDesign"],
};

const staged = JSON.parse(readFileSync(new URL("./staging/entries.json", import.meta.url), "utf8"));
let failed = false;
const err = (id: string, msg: string) => { failed = true; console.log(`  - ${id}: ${msg}`); };

for (const [assetId, rec] of Object.entries(staged.entries) as [string, any][]) {
  const entry = rec.entry;
  const result = MechanismReviewOverlaySchema.safeParse(entry);
  if (!result.success) {
    failed = true;
    console.log(`${assetId}: SCHEMA INVALID`);
    for (const issue of result.error.issues) console.log(`  - ${issue.path.join(".")}: ${issue.message}`);
    continue;
  }
  const arch = entry.archetype;
  const needMetrics = ARCHETYPE_METRICS[arch];
  const allowComps = ARCHETYPE_COMPONENTS[arch];
  if (entry.profileReview === undefined) {
    for (const k of needMetrics) if (!(k in entry.metrics)) err(assetId, `missing required metric ${k}`);
    for (const k of Object.keys(entry.metrics)) if (!needMetrics.includes(k)) err(assetId, `unknown metric ${k}`);
    for (const k of Object.keys(entry.components)) if (!allowComps.includes(k)) err(assetId, `unknown component ${k}`);
    for (const k of needMetrics) {
      const v = entry.metrics[k];
      const appl = entry.metricApplicability?.[k];
      if (v == null && (!appl || appl.state === "measured")) err(assetId, `null metric ${k} without non-measured applicability`);
      if (v != null && appl && appl.state !== "measured") err(assetId, `numeric metric ${k} marked ${appl.state}`);
      if (arch === "cdp" && appl?.state === "unavailable") err(assetId, `cdp metric ${k} marked unavailable (forbidden)`);
      if (arch === "algorithmic" && v == null) err(assetId, `algorithmic metric ${k} must be numeric`);
    }
    for (const k of Object.keys(entry.metricApplicability ?? {})) if (!needMetrics.includes(k)) err(assetId, `applicability for unknown metric ${k}`);
  }
}
console.log(failed ? "VALIDATION FAILED" : `ALL ${Object.keys(staged.entries).length} STAGED ENTRIES VALID`);
process.exit(failed ? 1 : 0);
