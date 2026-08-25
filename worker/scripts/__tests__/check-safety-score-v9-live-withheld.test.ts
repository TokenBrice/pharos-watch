import { describe, expect, it } from "vitest";
import { deriveReportCardsBaseInputGenerationId } from "@shared/lib/report-cards-base-input-identity";
import { buildSafetyScoreV9BaselineExtension, type V9ExtensionRegistryMeta } from "../../src/lib/safety-score-v9-extension";
import { buildSafetyScoreV9Candidate } from "../../src/lib/safety-score-v9-candidate";
import { eligibleReserveMeta } from "../../src/lib/__tests__/safety-score-v9-reserve-admission.test-support";
import { makeV9TwoAssetFixedInput, v9TestClockSec } from "../../src/test-helpers/v9-fixed-input";
import { buildLiveWithheldCounterfactualReport } from "../check-safety-score-v9-live-withheld";

function fixtureMeta(id: string, overrides: Partial<V9ExtensionRegistryMeta> = {}): V9ExtensionRegistryMeta {
  return eligibleReserveMeta({
    id,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
    liveReservesConfig: {
      adapter: "curated-validated",
      version: 1,
      semantics: "collateral-mix",
      inputs: { primary: { kind: "onchain-solana" } },
    },
    ...overrides,
  });
}

function healthyReplay() {
  const base = makeV9TwoAssetFixedInput({ clockSec: v9TestClockSec() });
  const fixed = structuredClone(base);
  fixed.liveReserveMap.beta = structuredClone(fixed.liveReserveMap.alpha);
  fixed.liveReserveProvenanceMap.beta = {
    source: "fixture-reserve-api",
    fetchedAt: fixed.clockSec - 100,
  };
  fixed.baseInputGenerationId = deriveReportCardsBaseInputGenerationId(fixed);
  const metaById = new Map<string, V9ExtensionRegistryMeta>([
    [
      "alpha",
      fixtureMeta("alpha", {
        mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
        proofOfReserves: undefined,
        reserveReview: { ...eligibleReserveMeta().reserveReview!, knownUnknownExposurePct: 1 },
      }),
    ],
    ["beta", fixtureMeta("beta")],
  ]);
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    allowRegistryMismatch: true,
    metaById,
  });
  const pipeline = buildSafetyScoreV9Candidate({
    fixedInput: fixed,
    extension,
    publishedAtSec: fixed.clockSec,
  });
  return {
    // The CLI reads a replay artifact off disk, so round-trip through JSON:
    // that is the shape under test and it drops the pipeline's readonly arrays.
    replay: JSON.parse(JSON.stringify({ pipeline })) as Parameters<
      typeof buildLiveWithheldCounterfactualReport
    >[0],
    metaById,
  };
}

describe("buildLiveWithheldCounterfactualReport", () => {
  it("reports a live-backed grade drop with fallback details and omits a held grade", () => {
    const { replay, metaById } = healthyReplay();

    const rows = buildLiveWithheldCounterfactualReport(replay, metaById);

    expect(rows).toEqual([
      expect.objectContaining({
        assetId: "alpha",
        liveGrade: "C",
        fallbackScore: null,
        fallbackGrade: "NR",
        fallbackTier: "none",
        fallbackEvidenceCeiling: null,
        fallbackBindingCapKind: null,
      }),
    ]);
    expect(rows[0]!.fallbackGrade).not.toBe(rows[0]!.liveGrade);
    expect(rows.some((row) => row.assetId === "beta")).toBe(false);
  });
});
