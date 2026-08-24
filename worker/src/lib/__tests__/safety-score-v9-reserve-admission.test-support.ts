/**
 * Shared reserve-admission fixtures. The curated composition, the prudential
 * mint profile and the signed independent report below are the exact shape the
 * V9 static-reserve admission gate requires, so several suites need the same
 * scaffolding: the phase 1 adapter tests assert which reports it admits, and
 * the backing fact-set tests assert what the compiler reports once admission
 * has already failed on age. Keeping one copy here is what the clone ratchet
 * asks for.
 */

import type { ReserveSlice } from "@shared/types/reserves";
import type { V9ExtensionRegistryMeta } from "../safety-score-v9-extension";

export const LIVE_RESERVES_CONFIG: NonNullable<V9ExtensionRegistryMeta["liveReservesConfig"]> = {
  adapter: "curated-validated",
  version: 1,
  semantics: "collateral-mix",
  inputs: { primary: { kind: "onchain-solana" } },
};

/** A prudentially supervised, issuer-controlled mint with a dated review. */
export function mintMeta(id: string, overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return {
    id,
    mintAuthority: {
      mintPath: "centralized",
      authorityPosture: "issuer-controlled",
      confidence: "verified",
      summary: "Fixture mint profile",
      review: {
        evidence: "Fixture evidence",
        reviewer: "fixture",
        reviewedAt: "2026-07-16",
      },
      supervision: "prudential",
    },
    ...overrides,
  } as V9ExtensionRegistryMeta;
}

/** The two-slice composition the admission gate accepts as a full composition. */
export function eligibleReserveRows(): ReserveSlice[] {
  return [
    {
      name: "Treasury repo",
      pct: 90,
      risk: "very-low",
      assetClass: "repo",
      issuerOrObligor: "Regulated counterparties",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "one-day",
      maturityDaysMax: 1,
    },
    {
      name: "Cash",
      pct: 10,
      risk: "very-low",
      assetClass: "bank-deposit",
      issuerOrObligor: "Commercial banks",
      riskFactors: ["counterparty", "custody"],
      liquidityHorizon: "immediate",
    },
  ];
}

/**
 * Admissible in every respect except the evaluation clock: `compositionAsOf`
 * and the report's `periodEnd` agree, and the report is signed by an
 * independent regional attestor. Evaluate near the composition date to test
 * admission, or far past it to test the expired-publication path.
 */
export function eligibleReserveMeta(overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return mintMeta("pyusd-paypal", {
    reserves: eligibleReserveRows(),
    reserveReview: {
      reviewedAt: "2026-07-16",
      reviewer: "fixture",
      confidence: "verified",
      sources: [{ label: "Composition", url: "https://example.com/composition" }],
      rationale: "Complete fixture composition",
      compositionBasis: "Signed report",
      compositionAsOf: "2026-06-30",
      scope: "full-composition",
      knownUnknownExposure: "None",
      knownUnknownExposurePct: 0,
    },
    proofOfReserves: {
      type: "independent-audit",
      url: "https://example.com/transparency",
      provider: "Independent LLP",
      attestorTier: "regional",
      cadence: "monthly",
      latestReport: {
        periodEnd: "2026-06-30",
        publishedAt: "2026-07-10",
        assuranceMethod: "examination",
        scope: "assets-and-liabilities",
        liabilityReconciliation: "full",
        reviewer: "fixture",
        confidence: "verified",
        sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }],
      },
    },
    ...overrides,
  });
}
