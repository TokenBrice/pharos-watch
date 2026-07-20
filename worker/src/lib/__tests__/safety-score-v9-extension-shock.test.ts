import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  hydrateSafetyScoreV9ShockCoverageExtension,
  selectSafetyScoreV9CdpShockMeasurement,
} from "../safety-score-v9-extension-shock";

const CAPTURE_9_CLOCK_SEC = 1_784_225_942;
const POST_JULY_17_CLOCK_SEC = 1_784_279_256;

const SHOCK_POLICY = {
  scoreShockFractionPpm: 500_000,
  sensitivityShockFractionsPpm: [400_000, 500_000, 600_000, 750_000],
  debtReconciliationTolerancePpm: 1_000,
};

function requireMeasurement(assetId: string, clockSec: number) {
  const measurement = selectSafetyScoreV9CdpShockMeasurement(assetId, clockSec);
  if (!measurement) throw new Error(`Expected a shock-coverage measurement for ${assetId}`);
  return measurement;
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

describe("selectSafetyScoreV9CdpShockMeasurement", () => {
  it("selects the complete chronology-valid LUSD and BOLD journals at the capture-9 clock", () => {
    const lusd = requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC);
    const bold = requireMeasurement("bold-liquity", CAPTURE_9_CLOCK_SEC);

    expect(lusd).toMatchObject({
      family: "liquity-v1-shock-v1",
      applicability: "measured",
      failureReason: null,
      complete: true,
      blockers: [],
      exactReplayPassed: true,
      replayVerification: {
        attestedAt: "2026-07-20",
        mode: "offline-byte-identical",
        callsConsumed: 265,
        codePinsConsumed: 14,
      },
      source: {
        journalPath:
          "shared/data/safety-score-v9/mechanism-measurements/lusd-liquity/2026-07-16-block-25546976-shock-coverage.json",
        journalSha256: "82bc042b7276ab49adba285117d171baf63cb0de85759eaffdb33d437eb8612d",
        block: {
          number: 25_546_976,
          hash: "0xe8218d4a35f40750dbc0f08c2cf74e641694ae2b5aa46150a6849e7d2429e1b5",
          timestampUnix: 1_784_225_939,
          timestampIso: "2026-07-16T18:18:59.000Z",
        },
        sourcePin: {
          repository: "https://github.com/liquity/dev",
          commit: "5174ecd0da4842157aba989499200d690b7e374f",
          liquidationContractPath: "packages/contracts/contracts/TroveManager.sol",
        },
      },
      shockPolicy: SHOCK_POLICY,
      stressShockFraction: 0.5,
      stressLiquidatableDebt: "0",
      stressPoolOffsetDebt: "0",
      stressLiquidationCoverageRatio: 1,
      evidenceRefIds: [],
    });
    expect(lusd.branchContributions).toEqual([
      {
        branchIndex: 0,
        stressLiquidatableDebt: "0",
        stressPoolOffsetDebt: "0",
        stressLiquidationCoverageRatio: 1,
      },
    ]);
    expect(lusd.codeHashPins).toHaveLength(14);
    expect(sha256Json(lusd.codeHashPins)).toBe("69b88d5cfc04dc03239c922761b3cd5d14a6c71506682cc28e538e31f95beacf");
    expect(lusd.codeHashPins[0]).toEqual({
      name: "lusd-token",
      address: "0x5f98805a4e8be255a32880fdec7f6728c6568ba0",
      role: "token",
      codeHash: "0xa607f4c8379ffb91323184b39d374287ea702b699648610ba87b29fd4f9b00a1",
    });
    expect(lusd.codeHashPins[lusd.codeHashPins.length - 1]).toEqual({
      name: "tellor-oracle",
      address: "0x88df592f8eb5d7bd38bfef7deb0fbc02cf3778a0",
      role: "oracle-fallback-source",
      codeHash: "0x18df49952ae206a293436515440bff85ba7a87d1ddf9ab0aab4e1fba63c11fbb",
    });

    expect(bold).toMatchObject({
      family: "liquity-v2-shock-v1",
      applicability: "measured",
      failureReason: null,
      complete: true,
      blockers: [],
      exactReplayPassed: true,
      replayVerification: {
        attestedAt: "2026-07-20",
        mode: "offline-byte-identical",
        callsConsumed: 746,
        codePinsConsumed: 54,
      },
      source: {
        journalPath:
          "shared/data/safety-score-v9/mechanism-measurements/bold-liquity/2026-07-16-block-25546976-shock-coverage.json",
        journalSha256: "51bcb1b5c177ad7b31ff0faab0b055b300edc7ea30be86c0f318ab9fe4056751",
        block: {
          number: 25_546_976,
          hash: "0xe8218d4a35f40750dbc0f08c2cf74e641694ae2b5aa46150a6849e7d2429e1b5",
          timestampUnix: 1_784_225_939,
          timestampIso: "2026-07-16T18:18:59.000Z",
        },
        sourcePin: {
          repository: "https://github.com/liquity/bold",
          commit: "c8a5a4ee2e9dc024905856b6698a77d849c68c7e",
          liquidationContractPath: "contracts/src/TroveManager.sol",
        },
      },
      shockPolicy: SHOCK_POLICY,
      stressShockFraction: 0.5,
      stressLiquidatableDebt: "17754332661241785789222466",
      stressPoolOffsetDebt: "14478681237083160155930867",
      stressLiquidationCoverageRatio: 0.815501292745,
      evidenceRefIds: [],
    });
    expect(bold.branchContributions).toEqual([
      {
        branchIndex: 0,
        stressLiquidatableDebt: "7525784708187349934083685",
        stressPoolOffsetDebt: "4250133284028724300792086",
        stressLiquidationCoverageRatio: 0.564742873843,
      },
      {
        branchIndex: 1,
        stressLiquidatableDebt: "9827824276178400497308524",
        stressPoolOffsetDebt: "9827824276178400497308524",
        stressLiquidationCoverageRatio: 1,
      },
      {
        branchIndex: 2,
        stressLiquidatableDebt: "400723676876035357830257",
        stressPoolOffsetDebt: "400723676876035357830257",
        stressLiquidationCoverageRatio: 1,
      },
    ]);
    expect(bold.codeHashPins).toHaveLength(54);
    expect(sha256Json(bold.codeHashPins)).toBe("5506e30422842f1773ed5860b198ac227c5721e5933e19fd6745bc0556098df1");
    expect(bold.codeHashPins[0]).toEqual({
      name: "bold-token",
      address: "0x6440f144b7e50d6a8439336510312d2f54beb01d",
      role: "token",
      codeHash: "0xfee79b645b7275fbcb4e4891bb08f7c881e01378af3ecd74fb4dc19c47750d21",
    });
    expect(bold.codeHashPins[bold.codeHashPins.length - 1]).toEqual({
      name: "interest-router-2",
      address: "0x807def5e7d057df05c796f4bc75c3fe82bd6eee1",
      role: "liquidation-interest-minting",
      codeHash: "0x2a91933e7f237a53ed6f699474a7618e16623dbcebb26702e494a9ce6382d5ce",
    });

    expect(lusd.source?.journalSha256).not.toBe("1743d17ab7921f5711926ae4c0eeac9cb25dbbade7f69ea6318aca5eb8e5ffca");
    expect(bold.source?.journalSha256).not.toBe("b881670992f4dae0cc94d616e56b6ec617039f45257f056f27cb58acbb76ae65");
  });

  it("returns no stress measurement for MIM or an unsupported asset", () => {
    expect(selectSafetyScoreV9CdpShockMeasurement("mim-abracadabra", CAPTURE_9_CLOCK_SEC)).toBeUndefined();
    expect(selectSafetyScoreV9CdpShockMeasurement("unsupported-cdp", CAPTURE_9_CLOCK_SEC)).toBeUndefined();
  });

  it("hydrates old extensions once while preserving replay-pinned measurements", () => {
    const pinnedLusd = requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC);
    const extension = {
      assets: [
        { assetId: "lusd-liquity", archetype: "cdp", cdpStressCoverage: pinnedLusd },
        { assetId: "bold-liquity", archetype: "cdp" },
        { assetId: "mim-abracadabra", archetype: "cdp" },
      ],
    };

    const hydrated = hydrateSafetyScoreV9ShockCoverageExtension(extension, CAPTURE_9_CLOCK_SEC) as typeof extension;
    expect(hydrated.assets[0]?.cdpStressCoverage).toBe(pinnedLusd);
    expect(hydrated.assets[1]?.cdpStressCoverage).toMatchObject({
      stressLiquidationCoverageRatio: 0.815501292745,
    });
    expect(hydrated.assets[2]).not.toHaveProperty("cdpStressCoverage");
  });

  it("rejects a fabricated replay-pinned measurement", () => {
    const fabricated = structuredClone(requireMeasurement("lusd-liquity", CAPTURE_9_CLOCK_SEC));
    if (!fabricated.source) throw new Error("Expected journal provenance");
    fabricated.source.journalSha256 = "f".repeat(64);

    expect(() =>
      hydrateSafetyScoreV9ShockCoverageExtension(
        { assets: [{ assetId: "lusd-liquity", archetype: "cdp", cdpStressCoverage: fabricated }] },
        CAPTURE_9_CLOCK_SEC,
      ),
    ).toThrow(/not in the committed registry/i);
  });

  it("selects the later LUSD and BOLD journals after the July 17 measurement clock", () => {
    const lusd = requireMeasurement("lusd-liquity", POST_JULY_17_CLOCK_SEC);
    const bold = requireMeasurement("bold-liquity", POST_JULY_17_CLOCK_SEC);

    expect(lusd).toMatchObject({
      source: {
        journalPath:
          "shared/data/safety-score-v9/mechanism-measurements/lusd-liquity/2026-07-17-block-25551407-shock-coverage.json",
        journalSha256: "1743d17ab7921f5711926ae4c0eeac9cb25dbbade7f69ea6318aca5eb8e5ffca",
        block: {
          number: 25_551_407,
          hash: "0xb4d76fb030d1970874ad821d279664182222e586d2482493a24dd8717cb81225",
          timestampUnix: 1_784_279_255,
          timestampIso: "2026-07-17T09:07:35.000Z",
        },
      },
      stressLiquidatableDebt: "0",
      stressPoolOffsetDebt: "0",
      stressLiquidationCoverageRatio: 1,
    });
    expect(bold).toMatchObject({
      source: {
        journalPath:
          "shared/data/safety-score-v9/mechanism-measurements/bold-liquity/2026-07-17-block-25551407-shock-coverage.json",
        journalSha256: "b881670992f4dae0cc94d616e56b6ec617039f45257f056f27cb58acbb76ae65",
        block: {
          number: 25_551_407,
          hash: "0xb4d76fb030d1970874ad821d279664182222e586d2482493a24dd8717cb81225",
          timestampUnix: 1_784_279_255,
          timestampIso: "2026-07-17T09:07:35.000Z",
        },
      },
      stressLiquidatableDebt: "17894837454764679091756881",
      stressPoolOffsetDebt: "14532694197596176032448614",
      stressLiquidationCoverageRatio: 0.812116580233,
    });
    expect(bold.branchContributions).toEqual([
      {
        branchIndex: 0,
        stressLiquidatableDebt: "7611779781059891657766840",
        stressPoolOffsetDebt: "4249636523891388598458573",
        stressLiquidationCoverageRatio: 0.558297355694,
      },
      {
        branchIndex: 1,
        stressLiquidatableDebt: "9882296864938511465684042",
        stressPoolOffsetDebt: "9882296864938511465684042",
        stressLiquidationCoverageRatio: 1,
      },
      {
        branchIndex: 2,
        stressLiquidatableDebt: "400760808766275968305999",
        stressPoolOffsetDebt: "400760808766275968305999",
        stressLiquidationCoverageRatio: 1,
      },
    ]);
  });
});
