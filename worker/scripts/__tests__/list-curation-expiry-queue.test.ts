import { describe, expect, it } from "vitest";

import executionReviewRegistry from "@shared/data/safety-score-v9/exit-execution-model-reviews-v1.json";
import { compileReviewedControlScope, v1005ReviewIsCurrent, weightedReviewIsCurrent } from "@shared/lib/safety-score-v9/control-scope";
import { V9_REVIEW_EVIDENCE_MAX_AGE_SEC } from "@shared/lib/safety-score-v9/evidence";
import { exitExecutionReviewDigest } from "@shared/lib/safety-score-v9/exit-execution";
import { V9_CANDIDATE_POLICY_V1 } from "@shared/lib/safety-score-v9/policy";
import { admitV10ReserveObservation, resolveV10ReserveObservationDeploymentRefs } from "@shared/lib/safety-score-v9/reserve-scope";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { ExitExecutionModelReviewSchema } from "@shared/types/exit-route";
import type { StablecoinMeta } from "@shared/types/core";
import { buildSafetyScoreV9ReserveBoundFacts } from "../../src/lib/safety-score-v9/extension-reserve-bounds";
import {
  buildCurationExpiryQueue,
  buildCurationExpiryReport,
  defaultCurationExpirySources,
  enumerateEvidenceFamilyBoundaries,
  renderCurationExpiryQueue,
  renderCurationExpiryReport,
  type CurationExpirySources,
} from "../list-curation-expiry-queue";

// 2026-08-20T13:17:29Z, the clock of the incident capture this queue was built for.
const CLOCK_SEC = 1_787_231_849;
const DAY = 86_400;

function isoDaysAgo(days: number): string {
  return new Date((CLOCK_SEC - days * DAY) * 1_000).toISOString().slice(0, 10);
}

function curatedMeta(id: string, compositionAsOf: string, reviewOverrides: Record<string, unknown> = {}): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: {},
    reserves: [
      {
        name: "USDC backing",
        pct: 100,
        risk: "low",
        coinId: "usdc-circle",
        depType: "collateral",
      },
    ],
    reserveReview: {
      reviewedAt: compositionAsOf,
      reviewer: "test",
      confidence: "verified",
      scope: "full-composition",
      knownUnknownExposurePct: 0,
      compositionAsOf,
      sources: [{ label: "test", url: "https://example.com/" }],
      ...reviewOverrides,
    },
  } as unknown as StablecoinMeta;
}

function replayFixture(options: {
  liveReserveMap?: Record<string, unknown>;
  liveToFallbackCoins?: string[];
  supplyById?: Record<string, number | null>;
} = {}) {
  return {
    pipeline: {
      fixedInput: {
        clockSec: CLOCK_SEC,
        liveReserveMap: options.liveReserveMap ?? {},
        liveToFallbackCoins: options.liveToFallbackCoins ?? [],
      },
      evaluatedSet: {
        assets: Object.entries(options.supplyById ?? {}).map(([assetId, circulatingUsd]) => ({
          assetId,
          stressState: { exitPortfolio: { circulatingUsd } },
        })),
      },
    },
  };
}

describe("buildCurationExpiryQueue", () => {
  it("lists only admitted compositions expiring within the lookahead, sorted by evaluated-set supply", () => {
    const metaById = new Map<string, StablecoinMeta>([
      // Admitted today, crosses the 31-day + 7-day grace bound within
      // the 10-day lookahead.
      ["small-expiring", curatedMeta("small-expiring", isoDaysAgo(30))],
      ["big-expiring", curatedMeta("big-expiring", isoDaysAgo(30))],
      ["unknown-supply-expiring", curatedMeta("unknown-supply-expiring", isoDaysAgo(30))],
      // Inadmissible today (non-zero known unknown): the worklist owns it.
      ["gap-inadmissible", curatedMeta("gap-inadmissible", isoDaysAgo(5), { knownUnknownExposurePct: 1.3 })],
      // Already past the 38-day effective bound: also worklist territory, not preventive.
      ["expired-out", curatedMeta("expired-out", isoDaysAgo(40))],
      // Fresh composition: admitted now and at the lookahead — excluded.
      ["fresh-ok", curatedMeta("fresh-ok", isoDaysAgo(2))],
      // Would expire, but a live snapshot published this cycle — excluded.
      ["live-covered", curatedMeta("live-covered", isoDaysAgo(25))],
    ]);

    const rows = buildCurationExpiryQueue(
      replayFixture({
        liveReserveMap: { "live-covered": [{ name: "live", pct: 100, risk: "low" }] },
        supplyById: {
          "big-expiring": 5_000_000,
          "small-expiring": 10_000,
          "unknown-supply-expiring": null,
        },
      }),
      10,
      metaById,
    );

    expect(rows.map((row) => [row.assetId, row.supplyUsd])).toEqual([
      ["unknown-supply-expiring", null],
      ["big-expiring", 5_000_000],
      ["small-expiring", 10_000],
    ]);
    expect(rows.every((row) => row.hasCollateralLinks)).toBe(true);
    expect(rows.every((row) => row.adapterState === "none")).toBe(true);
  });

  it("distinguishes null, missing and observed zero supply in deterministic ordering and rendered totals", () => {
    const ids = ["zero", "unknown-z", "known", "unknown-a"];
    const rows = buildCurationExpiryQueue(
      replayFixture({ supplyById: { zero: 0, "unknown-z": null, known: 42 } }),
      10,
      new Map(ids.map((id) => [id, curatedMeta(id, isoDaysAgo(30))])),
    );
    expect(rows.map((row) => [row.assetId, row.supplyUsd, row.supplyAvailability])).toEqual([
      ["unknown-a", null, "unavailable"],
      ["unknown-z", null, "unavailable"],
      ["known", 42, "known"],
      ["zero", 0, "known"],
    ]);
    expect(rows[0].supplyUnavailableReason).toBe("missing-captured-supply");
    const markdown = renderCurationExpiryQueue(rows, 10);
    expect(markdown).toContain("2 known, 2 unavailable; known-supply subtotal USD 42 (not a full-cohort total)");
    expect(markdown).toContain("| unknown-a | unavailable | missing-captured-supply |");
    expect(markdown).toContain("| zero | 0 | known |");
  });
});

// ---------------------------------------------------------------------------
// Active evidence families. Registries are injected: no live-registry counts.
// ---------------------------------------------------------------------------

const HORIZON_SEC = CLOCK_SEC + 10 * DAY;
const isoSec = (sec: number) => new Date(sec * 1_000).toISOString();
const isoDate = (sec: number) => isoSec(sec).slice(0, 10);

function emptySources(overrides: Partial<CurationExpirySources> = {}): CurationExpirySources {
  return {
    metaById: new Map(),
    executionReviews: [],
    supplyAttribution: {},
    economicPlanQuarantines: new Map(),
    transferReviews: [],
    reserveBoundFacts: {},
    wrapperReviews: {},
    operationalResilienceOverlays: null,
    ...overrides,
  };
}

function familyReplay(options: {
  supplyById?: Record<string, number | null>;
  liveReserveMap?: Record<string, unknown>;
  compiledAssets?: unknown[] | null;
  extensionAssets?: unknown[] | null;
  economicModels?: Record<string, string>;
} = {}) {
  const base = replayFixture({ supplyById: options.supplyById, liveReserveMap: options.liveReserveMap });
  return {
    pipeline: {
      ...base.pipeline,
      fixedInput: {
        ...base.pipeline.fixedInput,
        baseInputGenerationId: "base-gen",
        sourceGeneration: "source-gen",
        safetyScoreV9SupplyAttributionById: Object.fromEntries(
          Object.entries(options.economicModels ?? {}).map(([id, model]) => [id, { model }]),
        ),
      },
      ...(options.compiledAssets === null ? {} : { compiledFacts: { assets: options.compiledAssets ?? [] } }),
      ...(options.extensionAssets === null ? {} : { extension: { assets: options.extensionAssets ?? [] } }),
    },
  };
}

function executionReview(assetId: string, reviewedAt: string, expiresAt: string) {
  const template = ExitExecutionModelReviewSchema.parse(executionReviewRegistry.reviews[0]);
  return { ...template, identity: { ...template.identity, assetId }, reviewedAt, expiresAt };
}

function transferReview(assetId: string, reviewedAt: string, attestation?: { reviewedAt: string; expiresAt: string }) {
  return {
    assetId,
    reviewedAt,
    ...(attestation ? { transferScopeAttestation: { ...attestation, deploymentKey: `ethereum:0x${"1".repeat(40)}` } } : {}),
  };
}

function rowKeys(rows: readonly { family: string; assetId: string; disposition: string }[]) {
  return rows.map((row) => [row.family, row.assetId, row.disposition]);
}

describe("buildCurationExpiryReport evidence families", () => {
  it("lists execution reviews at the exact inclusive boundary but not one second later, joined to compiled certificates", () => {
    const due = executionReview("exec-due", isoSec(CLOCK_SEC - 20 * DAY), isoSec(HORIZON_SEC - 1));
    const later = executionReview("exec-later", isoSec(CLOCK_SEC - 20 * DAY), isoSec(HORIZON_SEC));
    const unjoined = executionReview("exec-unjoined", isoSec(CLOCK_SEC - 20 * DAY), isoSec(CLOCK_SEC + DAY));
    const report = buildCurationExpiryReport(
      familyReplay({
        compiledAssets: [{
          assetId: "exec-due",
          exitRoutes: [{ routeKey: "redemption:g:r", scoreEligible: true, executionCertificate: { reviewDigest: exitExecutionReviewDigest(due) } }],
        }],
      }),
      10,
      emptySources({ executionReviews: [due, later, unjoined] }),
    );
    expect(report.status).toBe("complete");
    expect(rowKeys(report.upcoming).sort()).toEqual([
      ["execution-review", "exec-due", "admitted"],
      ["execution-review", "exec-unjoined", "unknown"],
    ]);
    const dueRow = report.upcoming.find((row) => row.assetId === "exec-due")!;
    expect(dueRow.lastAdmittedSec).toBe(HORIZON_SEC - 1);
    expect(dueRow.boundarySemantics).toBe("inclusive");
    expect(dueRow.scope).toContain(exitExecutionReviewDigest(due));
    expect(report.upcoming.find((row) => row.assetId === "exec-unjoined")!.reason).toBe("no-captured-certificate-for-review");
    expect(report.census.find((row) => row.family === "execution-review")).toMatchObject({ records: 3, upcoming: 2, later: 1 });
  });

  it("treats a missing compiled-facts join as an explicit partial census, never a healthy admission", () => {
    const review = executionReview("exec-due", isoSec(CLOCK_SEC - DAY), isoSec(CLOCK_SEC + DAY));
    const report = buildCurationExpiryReport(familyReplay({ compiledAssets: null }), 10, emptySources({ executionReviews: [review] }));
    expect(report.status).toBe("partial");
    expect(report.diagnostics.map((row) => row.message)).toContain("replay-field-missing:pipeline.compiledFacts.assets");
    expect(report.upcoming[0]).toMatchObject({ disposition: "unknown", reason: "replay-compiled-facts-missing" });
    const markdown = renderCurationExpiryReport(report);
    expect(markdown).toContain("Report status: **partial**");
    expect(markdown.indexOf("## Census diagnostics")).toBeLessThan(markdown.indexOf("## Upcoming active evidence deadlines"));
  });

  it("projects supply plans, partitions, exclusions and native single-route reviews with their own boundary semantics", () => {
    const window = (assetId: string, expiresAtSec: number, extra: Record<string, unknown> = {}) =>
      ({ assetId, reviewedAtSec: CLOCK_SEC - 20 * DAY, expiresAtSec, ...extra });
    const maxAgeDays = V9_CANDIDATE_POLICY_V1.policy.semantic.supplyAttribution.reviewMaxAgeDays;
    const report = buildCurationExpiryReport(
      familyReplay({
        economicModels: { "plan-admitted": "reviewed-economic-deployment-partition-v1" },
        extensionAssets: [
          { assetId: "plan-admitted", supplyReview: { selectedBridgeRoutes: [] } },
          { assetId: "excluded", supplyReview: { selectedBridgeRoutes: [], providerRowExclusions: [{ review: { assetId: "excluded", chainId: "fraxtal", contractAddress: "0xabc" } }] } },
          { assetId: "native", supplyReview: { selectedBridgeRoutes: [{ deploymentRouteKey: "gnosis:native", supplyShare: 1 }] } },
        ],
      }),
      10,
      emptySources({
        economicPlanQuarantines: new Map([["plan-quarantined", new Error("bad plan")]]),
        supplyAttribution: {
          // Exclusive explicit expiry: expiresAtSec = horizon is last admitted one second earlier.
          reviews: [window("plan-admitted", HORIZON_SEC), window("plan-quarantined", HORIZON_SEC), window("plan-later", HORIZON_SEC + 1)],
          providerChainPartitionReviews: [window("partitioned", CLOCK_SEC + DAY, { chainId: "xlayer" })],
          providerRowExclusionReviews: [window("excluded", CLOCK_SEC + DAY, { chainId: "fraxtal", contractAddress: "0xabc" })],
          nativeSingleRouteReviews: [{ assetId: "native", routeId: "gnosis:native", reviewedAt: isoDate(HORIZON_SEC - maxAgeDays * DAY - DAY) }],
        },
      }),
    );
    expect(rowKeys(report.upcoming).sort()).toEqual([
      ["supply-native-single-route", "native", "admitted"],
      ["supply-partition", "partitioned", "unknown"],
      ["supply-plan", "plan-admitted", "admitted"],
      ["supply-plan", "plan-quarantined", "rejected"],
      ["supply-row-exclusion", "excluded", "admitted"],
    ]);
    const plan = report.upcoming.find((row) => row.assetId === "plan-admitted")!;
    expect(plan).toMatchObject({ boundarySec: HORIZON_SEC, boundarySemantics: "exclusive", lastAdmittedSec: HORIZON_SEC - 1 });
    expect(report.census.find((row) => row.family === "supply-plan")!.later).toBe(1);
  });

  it("derives transfer review and scope-attestation boundaries independently, with an earlier policy cap winning", () => {
    const accessMaxAge = V9_CANDIDATE_POLICY_V1.policy.semantic.evidence.evidenceExpiry.accessReviewMaxAgeSec;
    const topReviewed = isoDate(HORIZON_SEC - accessMaxAge - DAY);
    const report = buildCurationExpiryReport(familyReplay(), 10, emptySources({
      transferReviews: [
        // Explicit expiry first (exclusive at the attestation date).
        transferReview("explicit-first", isoDate(CLOCK_SEC - DAY), { reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + 2 * DAY) }),
        // The review-age bound closes before an authored far-future expiry.
        transferReview("policy-first", isoDate(CLOCK_SEC - DAY), {
          reviewedAt: isoDate(CLOCK_SEC + 5 * DAY - V9_REVIEW_EVIDENCE_MAX_AGE_SEC),
          expiresAt: isoDate(CLOCK_SEC + 400 * DAY),
        }),
        transferReview("top-level-due", topReviewed),
      ],
    }));
    const byAsset = (assetId: string, family: string) => report.upcoming.find((row) => row.assetId === assetId && row.family === family)!;
    expect(byAsset("explicit-first", "transfer-scope")).toMatchObject({ controllingBudget: "explicit expiresAt", boundarySemantics: "exclusive" });
    expect(byAsset("policy-first", "transfer-scope").controllingBudget).toContain("reviewedResearchMaxAgeSec");
    expect(byAsset("policy-first", "transfer-scope").boundarySemantics).toBe("inclusive");
    expect(byAsset("top-level-due", "transfer-review")).toMatchObject({ disposition: "unknown", reason: "material-scope-join-not-reproduced" });
    expect(report.upcoming.filter((row) => row.family === "transfer-review").map((row) => row.assetId)).toEqual(["top-level-due"]);
  });

  it("enrolls scoped control questions and process reviews from mint and bridge profiles via exported resolvers", () => {
    const questionReviewed = HORIZON_SEC - 1 - 90 * DAY;
    const processExpires = isoDate(CLOCK_SEC + 3 * DAY);
    const meta = {
      ...curatedMeta("controlled", isoDaysAgo(2)),
      mintAuthority: {
        authorityGraph: { review: {
          observedAt: isoDate(CLOCK_SEC - 10 * DAY), reviewedAt: isoDate(CLOCK_SEC - 9 * DAY), expiresAt: processExpires, reviewer: "test",
          pin: { chain: "ethereum", position: "1", hash: `0x${"a".repeat(64)}`, timestamp: isoSec(CLOCK_SEC - 10 * DAY) },
        } },
        review: { scopedQuestions: [{ controlRef: "ethereum:0xabc", question: "Is the minter key independent?", reviewedAt: isoSec(questionReviewed), reviewer: "test" }] },
      },
      bridgeRouteRisk: { scopedQuestions: [{ controlRef: "route-a", question: "Who can pause the bridge?", reviewedAt: isoDate(CLOCK_SEC - 200 * DAY), reviewer: "test" }] },
    } as unknown as StablecoinMeta;
    const report = buildCurationExpiryReport(familyReplay(), 10, emptySources({ metaById: new Map([["controlled", meta]]) }));
    const process = report.upcoming.find((row) => row.family === "mint-control")!;
    expect(process).toMatchObject({ assetId: "controlled", disposition: "admitted", lastAdmittedSec: Date.parse(`${processExpires}T00:00:00Z`) / 1_000 });
    expect(process.scope).toContain("mintAuthority/authorityGraph/review");
    const question = report.upcoming.find((row) => row.family === "scoped-control-question")!;
    expect(question.lastAdmittedSec).toBe(HORIZON_SEC - 1);
    expect(question.scope).toContain("ethereum:0xabc");
    expect(report.lapsed.map((row) => [row.family, row.scope.split(" ")[0]])).toEqual([["scoped-control-question", "bridge-control"]]);
  });

  it("keeps a live-covered asset's family rows even though its reserve-composition row is skipped", () => {
    const report = buildCurationExpiryReport(
      familyReplay({ liveReserveMap: { "live-covered": [{ name: "live", pct: 100, risk: "low" }] } }),
      10,
      emptySources({
        metaById: new Map([["live-covered", curatedMeta("live-covered", isoDaysAgo(30))]]),
        transferReviews: [transferReview("live-covered", isoDate(CLOCK_SEC - DAY), { reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + DAY) })],
      }),
    );
    expect(report.reserveRows).toEqual([]);
    expect(rowKeys(report.upcoming)).toEqual([["transfer-scope", "live-covered", "unknown"]]);
  });

  it("isolates malformed records and conflicting duplicate identities, merging exact aliases", () => {
    const good = transferReview("good", isoDate(CLOCK_SEC - DAY), { reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + DAY) });
    const conflicting = transferReview("dup", isoDate(CLOCK_SEC - DAY), { reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + 2 * DAY) });
    const report = buildCurationExpiryReport(familyReplay(), 10, emptySources({
      transferReviews: [{ assetId: "broken" }, good, good, conflicting,
        transferReview("dup", isoDate(CLOCK_SEC - DAY), { reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + 3 * DAY) })],
    }));
    expect(report.status).toBe("partial");
    expect(report.diagnostics.map((row) => row.scope)).toContain("transfer-review-overlays-v1.json#/reviews/0");
    expect(report.diagnostics.map((row) => row.message)).toContain("duplicate-scope-identity-with-conflicting-clocks");
    expect(report.upcoming.filter((row) => row.assetId === "good")).toHaveLength(1);
    expect(report.upcoming.filter((row) => row.assetId === "dup")).toHaveLength(1);
  });

  it("sums supply once per distinct asset and keeps null, missing and observed zero distinct", () => {
    const window = (assetId: string, chainId: string) => ({ assetId, chainId, reviewedAtSec: CLOCK_SEC - DAY, expiresAtSec: CLOCK_SEC + DAY });
    const report = buildCurationExpiryReport(familyReplay({ supplyById: { multi: 100, zero: 0, nulled: null } }), 10, emptySources({
      supplyAttribution: { providerChainPartitionReviews: [window("multi", "a"), window("multi", "b"), window("zero", "a"), window("nulled", "a"), window("missing", "a")] },
    }));
    expect(report.upcoming.map((row) => [row.assetId, row.supplyUsd])).toEqual([
      ["missing", null], ["nulled", null], ["multi", 100], ["multi", 100], ["zero", 0],
    ]);
    expect(report.upcoming.map((row) => row.supplyUnavailableReason)).toEqual(["missing-captured-supply", null, null, null, null]);
    expect(renderCurationExpiryReport(report)).toContain("2 known, 2 unavailable; known-supply subtotal USD 100 (not a full-cohort total)");
  });

  it("accounts wrapper and operational overlays as an inactive/history census, never as upcoming renewals", () => {
    const report = buildCurationExpiryReport(familyReplay(), 10, emptySources({
      wrapperReviews: { reviews: [{ assetId: "w", reviewedAt: isoDate(CLOCK_SEC - DAY), expiresAt: isoDate(CLOCK_SEC + DAY) }], localReviews: [{ assetId: "w", expiresAtSec: CLOCK_SEC - DAY }] },
      operationalResilienceOverlays: [{ assetId: "o", expiresAt: isoDate(CLOCK_SEC + DAY) }],
    }));
    expect(report.upcoming).toEqual([]);
    expect(report.inactiveHistory.map((row) => [row.disposition, row.records, row.datesPassed, row.datesWithinLookahead])).toEqual([
      ["inactive", 1, 0, 1], ["inactive", 1, 1, 0], ["history", 1, 0, 1],
    ]);
    const absent = buildCurationExpiryReport(familyReplay(), 10, emptySources()).inactiveHistory[2]!;
    expect(absent.records).toBeNull();
  });
});

describe("evidence family boundary parity with production resolvers (canonical registries)", () => {
  const { boundaries, diagnostics } = enumerateEvidenceFamilyBoundaries(replayFixture(), defaultCurationExpirySources());

  it("parses every canonical record without census diagnostics", () => {
    expect(diagnostics).toEqual([]);
  });

  it("matches execution-scope, weighted-quorum and process-review resolvers at the exact boundary and one second later", () => {
    let checked = 0;
    for (const row of boundaries.filter((entry) => entry.family === "mint-control" || entry.family === "bridge-control")) {
      const meta = ACTIVE_META_BY_ID.get(row.assetId)!;
      const pointer = row.source.replace(/^meta\./, "").split("/");
      const record = pointer.reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], meta) as never;
      const kind = row.scope.split(" ")[0];
      if (kind === "execution-scope") {
        const expired = (clockSec: number) => compileReviewedControlScope(record, (record as { controllerDeployment: string }).controllerDeployment,
          row.assetId, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC).diagnostics.includes("execution-review-expired");
        expect([row.source, expired(row.lastAdmittedSec), expired(row.lastAdmittedSec + 1)]).toEqual([row.source, false, true]);
      } else {
        const current = (clockSec: number) => kind === "weighted-quorum"
          ? weightedReviewIsCurrent(record, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC)
          : v1005ReviewIsCurrent(record, clockSec, V9_REVIEW_EVIDENCE_MAX_AGE_SEC);
        // Other gates (status, pins) may reject at both clocks; the boundary never extends.
        expect([row.source, current(row.lastAdmittedSec + 1)]).toEqual([row.source, false]);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("matches the scoped reserve-observation admission at the exact boundary and one second later", () => {
    const rows = boundaries.filter((entry) => entry.family === "reserve-observation");
    for (const row of rows) {
      const meta = ACTIVE_META_BY_ID.get(row.assetId)!;
      const observation = meta.reserveReview!.observations![Number(row.source.split("/").pop())]!;
      const expired = (clockSec: number) => admitV10ReserveObservation({
        observation, deploymentRefs: resolveV10ReserveObservationDeploymentRefs(meta), clockSec, policy: V9_CANDIDATE_POLICY_V1.policy,
      }).rejectionCodes.includes("expired");
      expect([row.source, expired(row.lastAdmittedSec), expired(row.lastAdmittedSec + 1)]).toEqual([row.source, false, true]);
    }
    expect(rows.length).toBeGreaterThan(0);
  });

  it("matches the production bound selection: a stale bound is filtered from compilation one second after its boundary", () => {
    const rows = boundaries.filter((entry) => entry.family === "reserve-bound-fact");
    for (const row of rows) {
      const selected = (clockSec: number) => buildSafetyScoreV9ReserveBoundFacts(row.assetId, [], { clockSec })
        .some((fact) => fact.factKey === row.scope);
      expect([row.scope, selected(row.lastAdmittedSec), selected(row.lastAdmittedSec + 1)]).toEqual([row.scope, true, false]);
    }
    expect(rows.length).toBeGreaterThan(0);
  });
});
