#!/usr/bin/env tsx
/**
 * Asserts every cross-file invariant that `status: "frozen"` requires.
 * Run as part of the shared validation gate.
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
import { ACTIVE_IDS, FROZEN_IDS, FROZEN_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { FROZEN_SNAPSHOTS_BY_ID } from "@shared/lib/stablecoins/frozen-snapshots";
import { DEAD_STABLECOINS } from "@shared/lib/dead-stablecoins";
// Independent registries that the freeze runbook requires us to clean up.
import { MINT_BURN_CONFIG_SPECS } from "../../worker/src/lib/mint-burn-contracts-data";
import { CONTRACT_CONFIGS } from "../../worker/src/lib/blacklist-contracts";
import { BLUECHIP_SLUG_MAP } from "@shared/lib/bluechip-slugs";
// Raw pool map — `yield-config.ts` re-exports this with no frozen filter,
// so the raw module is the source of truth for "is this id present?".
import { YIELD_POOL_MAP } from "../../worker/src/lib/yield-config/yield-config-pools";
import { STATIC_COMPARE_PAIRS } from "../../src/lib/compare-pages";

const failures: string[] = [];

// 1. frozen coins have well-formed obituaries (already enforced by Zod schema —
//    duplicate check here for fast feedback)
for (const coin of FROZEN_STABLECOINS) {
  if (!coin.frozenAt) {
    failures.push(`${coin.id}: missing frozenAt (shared/data/stablecoins/coins/*.json)`);
  }
  if (!coin.obituary) {
    failures.push(`${coin.id}: missing obituary (shared/data/stablecoins/coins/*.json)`);
  }
}

// 2. every frozen coin has a frozen-snapshots.json entry
for (const coin of FROZEN_STABLECOINS) {
  if (!FROZEN_SNAPSHOTS_BY_ID.has(coin.id)) {
    failures.push(
      `${coin.id}: missing entry in shared/data/stablecoins/frozen-snapshots.json — run scripts/maintenance/freeze-stablecoin.ts to generate the snapshot`,
    );
  }
}

// 3. id disjoint with dead-stablecoins.json
const deadIds = new Set(DEAD_STABLECOINS.map((d) => d.id));
for (const id of FROZEN_IDS) {
  if (deadIds.has(id)) {
    failures.push(
      `${id}: appears in BOTH shared/data/dead-stablecoins.json and FROZEN_STABLECOINS — pick one lifecycle (frozen OR dead, not both)`,
    );
  }
}

// 4. independent registries do not contain frozen ids
for (const config of MINT_BURN_CONFIG_SPECS) {
  if (FROZEN_IDS.has(config.stablecoinId)) {
    failures.push(
      `${config.stablecoinId}: still in MINT_BURN_CONFIG_SPECS (worker/src/lib/mint-burn-contracts-data.ts) — remove per freeze runbook`,
    );
  }
}
for (const config of CONTRACT_CONFIGS) {
  const id = (config as { stablecoinId?: string }).stablecoinId ?? "";
  if (FROZEN_IDS.has(id)) {
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
for (const id of Object.keys(YIELD_POOL_MAP)) {
  if (FROZEN_IDS.has(id)) {
    failures.push(`${id}: still in YIELD_POOL_MAP (worker/src/lib/yield-config/yield-config-pools.ts) — remove per freeze runbook`);
  }
}
for (const [leftId, rightId] of STATIC_COMPARE_PAIRS) {
  if (FROZEN_IDS.has(leftId)) {
    failures.push(
      `STATIC_COMPARE_PAIRS contains frozen left id ${leftId} (src/lib/compare-pages.ts) — remove pair per freeze runbook`,
    );
  }
  if (FROZEN_IDS.has(rightId)) {
    failures.push(
      `STATIC_COMPARE_PAIRS contains frozen right id ${rightId} (src/lib/compare-pages.ts) — remove pair per freeze runbook`,
    );
  }
}

// 5. ACTIVE and FROZEN are disjoint (registry-level invariant; double-check)
for (const id of FROZEN_IDS) {
  if (ACTIVE_IDS.has(id)) {
    failures.push(
      `${id}: appears in BOTH ACTIVE and FROZEN — registry semantic shift incomplete (shared/lib/stablecoins/registry.ts)`,
    );
  }
}

if (failures.length > 0) {
  console.error("Frozen-invariant failures:");
  for (const f of failures) console.error(` - ${f}`);
  process.exit(1);
}
console.log(`Frozen-invariant checks passed (${FROZEN_STABLECOINS.length} frozen coin(s)).`);
