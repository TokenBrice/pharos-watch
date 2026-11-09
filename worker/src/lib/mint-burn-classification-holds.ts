/**
 * Coins whose published signed nets are known to be wrong because a classification
 * defect excludes one side of real supply movements (R2: an unresolved observation
 * never becomes a positive claim). Publication withholds their nets, baselines and
 * bounds and treats them as partial scope; scanning, admission and the watermark are
 * unaffected. Remove an entry only after its classifier fix and history repair land.
 *
 * Evidence: 2026-11-09 roster-wide supply-conservation review (methodology v6.37).
 */
const MINT_BURN_CLASSIFICATION_HOLDS: ReadonlyMap<string, string> = new Map([
  // Burns through internal calls (DaiJoin.join) fail the per-receipt supply proof and
  // stay review_required while every mint counts: 30d net +$19.2B vs supply −$45M/7d.
  ["dai-makerdao", "proof-gated-burns-unresolved"],
  // Same proof gate: counted mints with all burns excluded since 2026-10-12.
  ["usdd-tron-dao-reserve", "proof-gated-burns-unresolved"],
  // CCTP v1 inbound mints still count as issuance and pre-2026-10-10 v2 inbound mints
  // remain in history: 90d net +$8.16B vs non-bridge supply change about −$4.79B.
  ["usdc-circle", "bridge-inbound-mints-counted"],
  // Modern CCIP sends are unrecognized and inbound pool mints count as issuance.
  ["zchf-frankencoin", "bridge-inbound-mints-counted"],
]);

export function isMintBurnClassificationHeld(stablecoinId: string): boolean {
  return MINT_BURN_CLASSIFICATION_HOLDS.has(stablecoinId);
}
