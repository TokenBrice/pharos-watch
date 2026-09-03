import { describe, expect, it } from "vitest";
import {
  buildSafetyScoreV9BaselineExtension,
  type V9ExtensionRegistryMeta,
} from "../safety-score-v9/extension";
import { compileSafetyScoreV9FactSetFromFixedInput } from "../safety-score-v9/fact-set";
import { makeV9FixedInput } from "../../test-helpers/v9-fixed-input";
import { eligibleReserveMeta, mintMeta } from "./safety-score-v9-reserve-admission.test-support";

const ASSET_ID = "alpha";
/** Far past the fixture composition, so its published evidence has expired. */
const EXPIRED_HISTORY_CLOCK_SEC = Date.UTC(2027, 7, 1) / 1_000;
const NO_HISTORY_CLOCK_SEC = Date.UTC(2026, 7, 1) / 1_000;
/** 55 days after the fixture composition: past 38d, inside 365d. */
const STALE_AUDITED_CLOCK_SEC = Date.UTC(2026, 7, 24) / 1_000;

function baseMeta(): V9ExtensionRegistryMeta {
  return mintMeta(ASSET_ID, {
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
  });
}

function expiredReserveMeta(): V9ExtensionRegistryMeta {
  return eligibleReserveMeta({
    id: ASSET_ID,
    mechanismArchetype: "fiat-cash",
    launchDate: "2020-01-01",
  });
}

function compileWithEmptyLiveReserves(
  meta: V9ExtensionRegistryMeta,
  clockSec: number,
  options: { observedFallingBack?: boolean } = {},
) {
  const fixed = makeV9FixedInput({
    assetId: ASSET_ID,
    clockSec,
    reserves: [],
  });
  if (options.observedFallingBack) {
    // The audited rung is only reachable for a coin whose live producer was
    // observed returning nothing this capture.
    (fixed as { liveToFallbackCoins: string[] }).liveToFallbackCoins = [ASSET_ID];
  }
  const extension = buildSafetyScoreV9BaselineExtension(fixed, {
    metaById: new Map([[ASSET_ID, meta]]),
  });
  return {
    fixed,
    extension,
    asset: compileSafetyScoreV9FactSetFromFixedInput(fixed, extension).assets[0]!,
  };
}

describe("Safety Score v9 backing fact-set reserve history", () => {
  it("reports expired published reserve composition evidence as stale", () => {
    const { fixed, extension, asset } = compileWithEmptyLiveReserves(
      expiredReserveMeta(),
      EXPIRED_HISTORY_CLOCK_SEC,
    );
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);
    expect(extension.assets[0]!.reviewedStaticReserveRows).toBeNull();
    expect(extension.assets[0]!.componentEvidence).toContainEqual(
      expect.objectContaining({ componentKey: "reserve-composition-history" }),
    );

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      message: "The last published reserve composition is older than the v9 freshness bound.",
      observationState: "stale",
      // The public label for `issuer-undisclosed` is "the issuer has not
      // disclosed this". This issuer did disclose and our window lapsed, so
      // attributing it to them is a false statement about the issuer.
      responsibility: "published-evidence-expired",
      evidenceRefIds: expect.arrayContaining([expect.any(String)]),
    });
    expect(reserveGap!.evidenceRefIds.length).toBeGreaterThan(0);
    expect(asset.reserveStatus).toMatchObject({
      observationState: "stale",
      evidenceRefIds: reserveGap!.evidenceRefIds,
    });
    for (const evidenceRefId of reserveGap!.evidenceRefIds) {
      expect(asset.evidence.find((evidence) => evidence.evidenceId === evidenceRefId)).toMatchObject({
        sourceId: "stablecoin-meta.expired-reviewed-static-reserves",
        freshness: { state: "stale" },
      });
    }
  });

  it("reports a generic missing reserve composition when no history exists", () => {
    const { fixed, extension, asset } = compileWithEmptyLiveReserves(baseMeta(), NO_HISTORY_CLOCK_SEC);
    expect(fixed.liveReserveMap[ASSET_ID]).toEqual([]);
    expect(extension.assets[0]!.componentEvidence).not.toContainEqual(
      expect.objectContaining({ componentKey: "reserve-composition-history" }),
    );

    const reserveGap = asset.gaps.find((gap) => gap.reasonCode === "missing-reserve-composition");
    expect(reserveGap).toMatchObject({
      reasonCode: "missing-reserve-composition",
      message: "No reserve composition is present in the exact fixed input.",
      observationState: "missing",
      responsibility: "issuer-undisclosed",
      evidenceRefIds: [],
    });
    expect(asset.reserveStatus).toMatchObject({
      observationState: "missing",
      evidenceRefIds: [],
    });
  });

  it("reports a stale audited composition on its own rung, not as a partial review", () => {
    // Composition dated 2026-06-30 read at 2026-08-24: past the 38-day
    // composition window so the emitted evidence is stale, but well inside the
    // 365-day audit window so the audited fallback still admits it. Calling
    // that a partial review would be inaccurate and would floor the ceiling at
    // the generic `limited` rung.
    const meta = eligibleReserveMeta({
      id: ASSET_ID,
      mechanismArchetype: "fiat-cash",
      launchDate: "2020-01-01",
      mintAuthority: { ...eligibleReserveMeta().mintAuthority!, supervision: "attestation-only" },
      liveReservesConfig: {
        adapter: "curated-validated",
        version: 1,
        semantics: "collateral-mix",
        inputs: { primary: { kind: "onchain-solana" } },
      },
    });
    const { extension, asset } = compileWithEmptyLiveReserves(meta, STALE_AUDITED_CLOCK_SEC, {
      observedFallingBack: true,
    });

    expect(extension.assets[0]!.reviewedStaticReserveRows).toMatchObject({
      evidenceClass: "static-validated",
      provenance: "audited-fallback",
    });
    const staleGap = asset.gaps.find((gap) => gap.reasonCode === "stale-audited-reserve-composition");
    expect(staleGap).toMatchObject({
      observationState: "stale",
      message: "The independently audited reserve composition is older than the v9 freshness bound.",
    });
    expect(asset.gaps.map((gap) => gap.reasonCode)).not.toContain("partial-reserve-review");
  });
});
