import type { V9ReasonCode } from "@shared/types";

/**
 * Plain-English labels for the public V9 reason codes. The enum values are
 * evaluator identifiers, not reader-facing copy, so every code surfaced in the
 * data-coverage module carries an explicit label instead of a humanized slug.
 *
 * Retired codes keep their label. The static page bundle and the Worker that
 * serves the report cards deploy independently, so a client can be handed a
 * payload authored either side of a methodology bump; an unlabelled code would
 * render an empty inventory row. Completeness for live codes is enforced below.
 *
 * Kept out of `safety-score-data-coverage.ts` (which imports the whole
 * OpenEvidence contract) so routes that only need a reason label — the digest
 * page — do not pull the open-evidence schemas into their client chunk.
 */
const REASON_CODE_LABELS = {
  // Neutral on cause, because the code carries two shapes: a component the
  // reviewer has not covered yet, and one the reviewer covered and found the
  // issuer does not publish (methodology 9.451). "Review incomplete" was false
  // for the second, which is most of them; the gap's own message now says which
  // shape it is, including the source checked and the date.
  "bounded-mechanism-review": "A mechanism detail is unresolved",
  "bounded-unknown-reserve-exposure": "Part of the reserve is unidentified",
  "correlated-exit-routes": "Exit routes share the same failure point",
  "critical-unresolved": "A rating-critical input is unresolved",
  "future-dated-input-fact": "An input is dated in the future",
  "historical-critical-input": "A rating-critical input is out of date",
  // Retired by methodology 9.04; label retained per the note above.
  "immaterial-unrecognized-chain-pool": "Small liquidity pool not recognized",
  "implementation-parent-cycle": "Circular dependency on a parent asset",
  "incomparable-route-requests": "Exit routes cannot be compared like for like",
  // Reads true for both shapes this code now covers: a partly covered surface,
  // and one with no reviewed pool at all because a deployment chain has no
  // registered discovery provider (v9.04 reclassification).
  "incomplete-dex-route-coverage": "DEX exit routes not fully covered",
  "incomplete-oracle-liquidation-branch": "Oracle liquidation path only partly reviewed",
  "inherited-access-exposure": "Freeze exposure inherited from a reviewed upstream asset",
  "reviewed-possible-access": "Freeze reach reviewed as possible, not proven",
  "insufficient-evidence": "Not enough evidence to rate this input",
  "material-bridge-supply-unmatched": "Bridged supply does not reconcile",
  "material-dependency-unavailable": "A material dependency could not be scored",
  "material-reserve-slice-unstructured": "Part of the reserve is not itemized",
  "material-unknown-reserve-exposure": "A material reserve holding is unidentified",
  "mint-control-question": "Open question about mint control",
  "missing-applicable-peg": "No applicable peg reference",
  "missing-archetype": "Mechanism archetype not classified",
  "missing-bridge-route-rows": "Bridge route data not available",
  "missing-bridge-routes": "Bridge routes not mapped",
  "missing-custody-profile": "Custody arrangements not published",
  "missing-implementation-date": "Implementation date unknown",
  "missing-latest-assurance-report": "No current attestation or audit",
  "missing-mint-authority": "Mint authority not identified",
  "missing-oracle-profile": "Oracle setup not documented",
  "missing-parent-score": "Parent asset has no score",
  "missing-peg-input": "Peg reference data missing",
  "peg-price-unavailable-adverse-history": "No usable price, and the peg record is adverse",
  "peg-supply-floor-withheld": "Peg deviation withheld below the $1M supply floor",
  "missing-pillar": "A scoring pillar has no inputs",
  "missing-access-review": "Transfer and freeze powers not reviewed",
  "missing-pillar-evidence": "A scoring pillar has no evidence",
  "missing-required-oracle-branches": "Required oracle paths not documented",
  "missing-reserve-composition": "Reserve composition not published",
  // Neutral on cause: the same code now covers a feed that did not deliver and
  // a chain Pharos has no discovery provider for. "No observation" is true of
  // both; "unavailable" implied a failure that did not always happen.
  "missing-runtime-route-evidence": "No live exit-route observation",
  "missing-same-notional-route": "No exit route at the tested size",
  "missing-upgrade-control": "Upgrade controls not identified",
  "missing-upgradeability-review": "Contract upgradeability not reviewed",
  "nonmaterial-bridge-supply-unmatched": "A trace of supply is not mapped to a bridge route",
  "nonmaterial-dependency-unavailable": "A minor dependency could not be scored",
  "no-viable-exit-path": "No viable exit path found",
  "oracle-topology-undisclosed": "The issuer has not disclosed the oracle topology",
  "parent-cycle": "Circular dependency between assets",
  // Neutral on cause: most carriers are wrappers whose inherited parent
  // exposure has no live verification, not reviews someone left unfinished;
  // the same code also covers a genuinely partial standalone review.
  "partial-reserve-review": "Reserve backing only partly verified",
  "runtime-bridge-materiality-unavailable": "Live bridge exposure unavailable",
  "scoped-control-question": "Reviewer-scoped control question open",
  "selected-bridge-route-missing": "Selected bridge route not found",
  "stale-audited-reserve-composition": "Audited reserve composition not current",
  "selected-bridge-route-unresolved": "Selected bridge route unresolved",
  "unknown-control-cap-authority": "Supply-cap authority unknown",
  "unknown-control-mint-ability": "Mint ability unknown",
  "unknown-upgrade-authority": "Upgrade authority unknown",
  "unresolved-control-identity": "Controlling entity not identified",
  "unresolved-exit-output": "Exit route payout asset unresolved",
  "unresolved-mint-authority": "Mint authority unresolved",
  "unresolved-oracle-branch-applicability": "Oracle path applicability unresolved",
  "unsupported-same-notional-route": "Exit route cannot be tested at size",
  "unproven-settlement-bound": "Settlement bound unproven",
  // The collateral identities are reviewed; what is absent is their
  // reconciliation against a measured reserve envelope, which for an asset with
  // no live-reserve adapter no method can produce at all.
  "unreviewed-dependency-relationships": "Dependency relationships not reconciled with reserves",
  "unreviewed-oracle-profile": "Oracle setup not reviewed",
  "unreviewed-reserve-envelope": "Reserve scope not reviewed",
  "partial-evidence-pipeline-gap": "Partial evidence",
  "single-pillar-pipeline-gap": "Only one pillar available — pipeline gap",
  "all-pillars-pipeline-gap": "No pillars available — pipeline gap",
  "f-without-measured-adverse": "Score below the F threshold without a measured adverse fact",
} satisfies Record<string, string>;

/** Compile-time guard: every live reason code must carry a label. */
const _liveReasonCodeLabels: Record<V9ReasonCode, string> = REASON_CODE_LABELS;

/** Reader-facing label for a stored reason code; archived payloads may carry unknown codes. */
export function formatV9ReasonCodeLabel(code: string): string {
  return (REASON_CODE_LABELS as Record<string, string>)[code] ?? code.replace(/-/g, " ");
}
