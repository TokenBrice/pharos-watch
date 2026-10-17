#!/usr/bin/env tsx
/**
 * Asserts cross-layer frozen-coin cleanup not owned by schema and runtime tests.
 * Run through the focused freeze validation gate.
 *
 * Failures here usually indicate a half-applied freeze procedure — fix
 * before finalizing. See `docs/freezing-stablecoins.md` (when present) for
 * the full runbook.
 *
 * Boundary waiver: frozen-invariants-lifecycle-registry-check. This script is
 * the only approved non-test cross-layer validator that imports worker and
 * frontend registries to prove frozen IDs were removed from lifecycle surfaces.
 * See `docs/process/boundary-waivers.md` for rationale, mitigations, and the
 * retirement assessment.
 */
import { FROZEN_IDS, FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
// Independent registries that the freeze runbook requires us to clean up.
import { MINT_BURN_CONFIG_SPECS } from "../../worker/src/lib/mint-burn-contracts-data";
import { CONTRACT_CONFIGS } from "../../worker/src/lib/blacklist-contracts";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
import { assertStaticComparePairs } from "../../src/lib/compare-pages";

const failures: string[] = [];

// Frozen IDs must remain disjoint with dead-stablecoins.json.
const deadIds = new Set(DEAD_STABLECOINS.map((d) => d.id));
for (const id of FROZEN_IDS) {
  if (deadIds.has(id)) {
    failures.push(
      `${id}: appears in BOTH shared/data/dead-stablecoins.json and FROZEN_STABLECOINS — pick one lifecycle (frozen OR dead, not both)`,
    );
  }
}

// Independent mint/burn, blacklist, Bluechip and compare registries exclude frozen IDs.
for (const config of MINT_BURN_CONFIG_SPECS) {
  if (FROZEN_IDS.has(config.stablecoinId)) {
    failures.push(
      `${config.stablecoinId}: still in MINT_BURN_CONFIG_SPECS (worker/src/lib/mint-burn-contracts-data.ts) — remove per freeze runbook`,
    );
  }
}
for (const config of CONTRACT_CONFIGS) {
  const id = "stablecoinId" in config ? config.stablecoinId : undefined;
  if (typeof id !== "string" || id.length === 0) {
    failures.push(
      "CONTRACT_CONFIGS entry is missing stablecoinId (worker/src/lib/blacklist-contracts.ts) — restore the required registry key",
    );
  } else if (FROZEN_IDS.has(id)) {
    failures.push(
      `${id}: still in CONTRACT_CONFIGS (worker/src/lib/blacklist-contracts.ts) — remove per freeze runbook`,
    );
  }
}
for (const id of Object.keys(BLUECHIP_SLUG_MAP)) {
  if (FROZEN_IDS.has(id)) {
    failures.push(`${id}: still in BLUECHIP_SLUG_MAP (shared/lib/bluechip-slugs.ts) — remove per freeze runbook`);
  }
}
assertStaticComparePairs();

if (failures.length > 0) {
  console.error("Frozen-invariant failures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`Frozen-invariant checks passed (${FROZEN_STABLECOINS.length} frozen coin(s)).`);
