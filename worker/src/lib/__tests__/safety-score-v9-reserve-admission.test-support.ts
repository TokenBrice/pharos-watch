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
import type { V9ExtensionRegistryMeta } from "../safety-score-v9/extension";
import { buildSafetyScoreV9Candidate } from "../safety-score-v9/candidate";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";

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

/** A whole-book, verified review of `reserves` dated 2026-06-30 (expired by mid-August 2026). */
function ceilingBook(id: string, reserves: ReserveSlice[], review: Partial<NonNullable<V9ExtensionRegistryMeta["reserveReview"]>> = {}) {
  return eligibleReserveMeta({ id, mechanismArchetype: "fiat-cash", launchDate: "2020-01-01", reserves,
    reserveReview: { ...eligibleReserveMeta().reserveReview!, ...review } });
}
const ENVELOPE = "Permitted reserve envelope, current weights unpublished";
const OWN = "Own-issued vault claim";

/** v10.48 admitted-ceiling books: what each scores admitted bounds what it may score expired. */
export const CEILING_BOOKS = {
  strong: () => ceilingBook("bravo", eligibleReserveRows()),
  /** The whole book is an unknown-weight residual (eusd-telcoin shape). */
  weak: () => ceilingBook("charlie", [{ name: ENVELOPE, pct: 100, risk: "very-low", assetClass: "other",
    riskFactors: ["counterparty"], liquidityHorizon: "unknown" }], {
    knownUnknownExposure: "Weights unpublished", knownUnknownExposurePct: 100,
    nonLinkDispositions: [{ reserveIndex: 0, reserveName: ENVELOPE, pct: 100, disposition: "insufficient-evidence",
      rationale: "The permitted envelope is published without current weights." }],
  }),
  /** 80% is a reviewed own-liability claim: zero credit when admitted (v10.47, usd0-usual shape). */
  ownLiability: () => ceilingBook("delta", [{ name: OWN, pct: 80, risk: "high", assetClass: "protocol-position",
    issuerOrObligor: "Fixture vault", riskFactors: ["counterparty"], liquidityHorizon: "over-seven-days" },
  { ...eligibleReserveRows()[1]!, pct: 20 }], {
    nonLinkDispositions: [{ reserveIndex: 0, reserveName: OWN, pct: 80, disposition: "self-reserve", ownLiability: true,
      rationale: "The vault's underlying asset is the issued coin itself." }],
  }),
  /** Named-firm report with direct assurance: a prudential issuer's rows admit as "independent". */
  named: () => {
    const meta = ceilingBook("foxtrot", eligibleReserveRows(), { compositionAsOf: "2026-03-31", reviewedAt: "2026-04-16",
      sources: [{ label: "Signed report", url: "https://example.com/report.pdf" }] });
    Object.assign(meta.proofOfReserves!.latestReport!, { periodEnd: "2026-03-31", publishedAt: "2026-04-10", reviewer: "Independent LLP" });
    return meta;
  },
  /** The report's coverage excludes a still-owed liability: a fresh review is not whole-book. */
  owedExclusion: () => {
    const ref = "ethereum:0x1111111111111111111111111111111111111111";
    const asOfSec = Date.parse("2026-06-30T23:59:59Z") / 1_000;
    const book = (bookKey: string) => ({ deploymentRef: ref, bookKey, account: null });
    const meta = ceilingBook("golf", eligibleReserveRows());
    meta.contracts = [{ chain: "ethereum", address: ref.slice(9), decimals: 18 }];
    meta.proofOfReserves!.latestReport!.coverage = { scopeId: "trust:june", liabilityBookKey: "issuer:trust", deploymentRefs: [ref],
      liabilityExclusions: [{ id: "legacy", identity: book("issuer:legacy"), kind: "legacy", reason: "Outstanding legacy liabilities",
        amount: "50", currency: "USD", unitBasis: "token-units", asOfSec, economicallyOwed: true,
        source: { url: "https://example.com/report.pdf", accessedAtSec: asOfSec + 86_400, sha256: "a".repeat(64) } }],
      denominator: { periodEnd: "2026-06-30", asOfSec, currency: "USD", unitBasis: "token-units", decimals: 18, totalCoveredLiabilities: "50",
        included: [{ identity: book("issuer:trust"), amount: "50", evidenceRefIds: ["source:report"] }], excluded: ["legacy"],
        completeness: "complete", evidenceRefIds: ["source:report"], sourceSha256: "a".repeat(64) },
      reconciliationWithinScope: "full", assetsAsOfSec: asOfSec, reviewedAtSec: asOfSec + 172_800, confidence: "verified" };
    return meta;
  },
  /** Half the book names a tracked asset, priced only through a dependency projection. */
  tracked: () => ceilingBook("echo", [{ name: "USDC held in reserve", pct: 50, risk: "low", coinId: "usdc-circle",
    depType: "collateral", assetClass: "stablecoin", issuerOrObligor: "Circle", riskFactors: ["counterparty"],
    liquidityHorizon: "immediate" }, { ...eligibleReserveRows()[0]!, pct: 50 }]),
};

/** One meta through the candidate pipeline with no live-reserve snapshot (a registry asset without a producer). */
export function compileCeilingCard(meta: V9ExtensionRegistryMeta, clockSec: number) {
  const result = buildSafetyScoreV9Candidate({
    fixedInput: makeV9FixedInput({ assetId: meta.id, clockSec, omitLiveReserve: true }),
    registry: { metaById: new Map([[meta.id, meta]]) }, publishedAtSec: clockSec + 10, includeReserveCompositionAdmission: true,
  });
  if (result.quarantines.length > 0) throw new Error(`${meta.id} quarantined`);
  const card = result.candidate.cards[0]!;
  const components = card.breakdowns?.backing.components ?? [];
  return { card, facts: result.compiledFacts.assets[0]!, components,
    reserves: card.breakdowns?.backing.groups.find((row) => row.key === "reserves")?.score ?? Number.NaN,
    residual: components.find((row) => row.key.startsWith("reserve:unclassified-residual")) };
}

/**
 * The same review dated `day` (inside its age budget; at least two days before
 * the clock). A report whose period matches moves with it, coverage checkpoints
 * included, so its own age gates see the same fresh period.
 */
export function reviewDatedOn(meta: V9ExtensionRegistryMeta, day: string): V9ExtensionRegistryMeta {
  const next = structuredClone(meta);
  const report = next.proofOfReserves?.latestReport;
  if (report && report.periodEnd === next.reserveReview!.compositionAsOf) {
    const shift = (Date.parse(day) - Date.parse(report.periodEnd!)) / 1_000;
    // Published the next day: a report cannot be published before its own checkpoint.
    Object.assign(report, { periodEnd: day, publishedAt: new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10) });
    const coverage = report.coverage;
    if (coverage) {
      coverage.denominator = { ...coverage.denominator, periodEnd: day, asOfSec: coverage.denominator.asOfSec + shift };
      coverage.assetsAsOfSec += shift;
      coverage.reviewedAtSec = Math.min(coverage.reviewedAtSec + shift, Date.parse(day) / 1_000 + 86_399);
      coverage.liabilityExclusions = coverage.liabilityExclusions.map((row) => ({ ...row, asOfSec: row.asOfSec + shift,
        source: { ...row.source, accessedAtSec: Math.min(row.source.accessedAtSec + shift, coverage.reviewedAtSec) } }));
    }
  }
  Object.assign(next.reserveReview!, { compositionAsOf: day, reviewedAt: day });
  return next;
}
