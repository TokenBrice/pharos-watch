import { describe, expect, it } from "vitest";
import zsd from "@shared/data/stablecoins/coins/zsd-zephyr-protocol.json";
import zys from "@shared/data/stablecoins/coins/zys-zephyr-protocol.json";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import { computeLiveReserveConfigFingerprint, getLiveReserveAdapterDefinition } from "@shared/lib/live-reserve-adapters";
import { evaluateLiveReserveAdmission } from "../../../lib/live-reserves/store-snapshot-state";
import { adaptZephyrScanner } from "../zephyr-scanner";
import { expectValidAdapterOutput } from "./reserve-adapter.test-support";
import { ZEPHYR_CAPTURE } from "./zephyr-scanner.test-support";

describe("adaptZephyrScanner", () => {
  it("maps latest reserve snapshot into a ZEPH protocol reserve slice with verified metadata", () => {
    const result = adaptZephyrScanner(ZEPHYR_CAPTURE);

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]).toMatchObject({ name: "ZEPH protocol reserve", pct: 100, risk: "high", assetClass: "cryptoasset", liquidityHorizon: "unknown" });
    expect(result.slices[0].riskFactors).toEqual(["smart-contract", "market", "liquidity", "concentration", "custody"]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1710000000,
      totalReserveUsd: 1_221_858.9661031931,
      supplyUsd: 385_036.81291444064,
      collateralizationRatio: 3.173356,
      reserveAssetAmount: 3_838_581.0555380915,
      reserveAssetPriceUsd: 0.31831006,
      reserveRatioMovingAverage: 3.218013,
      zsdYieldReserve: 315_747.159842202,
      reserveHeight: 773828,
      hardForkVersion: 11,
    });
    expect(result.warnings).toBeUndefined();
  });

  it("bounds reserve freshness by the used price, not a newer capture", () => {
    const snapshot = ZEPHYR_CAPTURE.results[0];
    const result = adaptZephyrScanner({ results: [{
      ...snapshot,
      captured_at: "2026-10-19T12:00:00Z",
    }] });
    expect(result.metadata?.sourceTimestamp).toBe(1710000000);
    expect(result.metadata?.details).toMatchObject({ capturedAt: "2026-10-19T12:00:00Z" });
  });

  it("does not borrow an unused alternative price clock", () => {
    const result = adaptZephyrScanner({ results: [{
      captured_at: "2026-10-19T12:00:00Z",
      on_chain: { zeph_reserve: 100, zsd_circ: 50 },
      pricing_record: { spot: 1_000_000_000_000 },
      raw: { pr: { spot: 2_000_000_000_000, timestamp: 1_792_411_200 } },
    }] });
    expect(result.metadata).toMatchObject({
      totalReserveUsd: 100, collateralizationRatio: 2, freshnessMode: "unverified",
      details: { freshnessReason: expect.any(String) },
    });
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });

  it("ignores stale clocks on unused alternatives", () => {
    const timestamp = 1_792_411_200;
    const result = adaptZephyrScanner({ results: [{
      captured_at: new Date(timestamp * 1000).toISOString(),
      on_chain: { zeph_reserve: 100, zsd_circ: 50 },
      pricing_record: { spot: 1_000_000_000_000, timestamp },
      raw: { pr: { spot: 2_000_000_000_000, timestamp: 1710000000 } },
    }] });
    expect(result.metadata?.sourceTimestamp).toBe(timestamp);
  });

  it.each([undefined, 1710000000])("requires the used ZYS coverage price clock (%s)", (timestamp) => {
    const result = adaptZephyrScanner({ results: [{
      captured_at: "2026-10-19T12:00:00Z",
      on_chain: { zsd_yield_reserve: 200, zys_circ: 100, reserve_ratio: 2 },
      pricing_record: { yield_price: 2_000_000_000_000, timestamp: 1_792_411_200 },
      raw: { pr: { timestamp } },
    }] }, "zys-zephyr-protocol");
    expect(result.metadata?.freshnessMode).toBe(timestamp == null ? "unverified" : "verified");
    expect(result.metadata?.sourceTimestamp).toBe(timestamp);
    expect(result.metadata?.details).toMatchObject({ capturedAt: "2026-10-19T12:00:00Z" });
  });

  it("requires a capture clock for amounts even when the price is dated", () => {
    const snapshot = ZEPHYR_CAPTURE.results[0];
    const result = adaptZephyrScanner({ results: [{ ...snapshot, captured_at: undefined }] });
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });

  it("does not date raw USD assets with a different selected spot clock", () => {
    const snapshot = ZEPHYR_CAPTURE.results[0];
    const result = adaptZephyrScanner({ results: [{
      ...snapshot,
      raw: { ...snapshot.raw, pr: { timestamp: 1700000000 } },
    }] });
    expect(result.metadata?.sourceTimestamp).toBe(1700000000);
  });

  it("requires the selected ZYS share-price clock independently of coverage", () => {
    const result = adaptZephyrScanner({ results: [{
      captured_at: "2026-10-19T12:00:00Z",
      on_chain: { zsd_yield_reserve: 200, zys_circ: 100 },
      pricing_record: { yield_price: 2_000_000_000_000 },
      raw: { pr: { reserve_ratio: 2_000_000_000_000, timestamp: 1_792_411_200 } },
    }] }, "zys-zephyr-protocol");
    expect(result.metadata?.freshnessMode).toBe("unverified");
    expect(result.metadata?.sourceTimestamp).toBeUndefined();
  });

  it.each([zsd, zys])("rejects retained capture-dated v1/v2 packets for $id", (coin) => {
    const config = coin.liveReservesConfig as LiveReservesConfig;
    expect(config.version).toBe(3);
    expect(getLiveReserveAdapterDefinition("zephyr-scanner")?.configValidation.allowedVersions).toEqual([3]);
    const snapshot = {
      stablecoinId: coin.id, source: config.adapter, fetchedAt: 1_778_000_000,
      slices: [{ name: "Zephyr reserve", pct: 100, risk: "high" as const }],
      metadata: { freshnessMode: "verified" as const, sourceTimestamp: 1_778_000_000 },
      warnings: [], warningCount: 0,
      adapterSourceModel: "single-bucket" as const, adapterEvidenceClass: "weak-live-probe" as const,
      configFingerprint: computeLiveReserveConfigFingerprint(config),
    };
    const sync = { lastSuccessAt: snapshot.fetchedAt, lastSuccessAttemptId: null };
    for (const version of [1, 2]) {
      expect(evaluateLiveReserveAdmission({
        ...snapshot, configFingerprint: computeLiveReserveConfigFingerprint({ ...config, version }),
      }, sync, { liveReservesConfig: config }, snapshot.fetchedAt).reasons).toContain("config-mismatch");
    }
    expect(evaluateLiveReserveAdmission(snapshot, sync, { liveReservesConfig: config }, snapshot.fetchedAt).reasons)
      .not.toContain("config-mismatch");
  });

  it("degrades undercollateralized snapshots", () => {
    const result = adaptZephyrScanner({
      results: [
        {
          captured_at: "2024-03-09T16:00:00.000Z",
          on_chain: {
            zeph_reserve: 100,
            zsd_circ: 200,
            reserve_ratio: 0.5,
          },
          pricing_record: {
            spot: 1000000000000,
          },
        },
      ],
    });

    expect(result.metadata?.collateralizationRatio).toBe(0.5);
    expect(result.warnings?.[0]).toMatchObject({
      code: "reserve-undercollateralized",
      effect: "degraded",
    });
  });

  it("maps the ZYS yield reserve to the exact tracked ZSD dependency", () => {
    const result = adaptZephyrScanner(
      {
        results: [
          {
            captured_at: "2026-07-19T23:46:28.729Z",
            reserve_height: 822991,
            on_chain: {
              zsd_yield_reserve_atoms: "355777179070495244",
              zys_circ_atoms: "183232761929264165",
              reserve_ratio: 4.38861,
            },
            pricing_record: {
              timestamp: 1784504312,
              yield_price: 1941667180000,
            },
            raw: {
              num_zyield: "183232761929264165",
              zyield_reserve: "355777179070495244",
            },
          },
        ],
      },
      "zys-zephyr-protocol",
    );

    expect(result.slices).toEqual([
      expect.objectContaining({
        name: "ZSD yield reserve backing ZYS shares",
        pct: 100,
        coinId: "zsd-zephyr-protocol",
        depType: "wrapper",
        assetClass: "stablecoin",
      }),
    ]);
    expect(result.metadata).toMatchObject({
      freshnessMode: "verified",
      sourceTimestamp: 1784504312,
      reserveAmountZsd: 355_777.17907049524,
      liabilityAmountZsd: 355_777.04013880575,
      zysCirculating: 183_232.76192926418,
      sharePriceZsd: 1.94166718,
      collateralizationRatio: 4.38861,
      details: {
        reserveAssetId: "zsd-zephyr-protocol",
        zysCirculating: 183_232.76192926418,
        sharePriceZsd: 1.94166718,
        adapterStatus: {
          asset: "zys-zephyr-protocol",
          sliceSumPct: 100,
          unresolvedBucketCount: 0,
          classificationResult: "complete",
        },
      },
    });
    expect(result.metadata).not.toHaveProperty("totalReserveUsd");
    expect(result.metadata).not.toHaveProperty("supplyUsd");

    expectValidAdapterOutput("zephyr-scanner", result, {
      subjectId: "zys-zephyr-protocol",
      knownStablecoinIds: new Set([
        "zsd-zephyr-protocol",
        "zys-zephyr-protocol",
      ]),
      now: 1784505000,
    });
  });

  it("rejects a ZYS snapshot whose published share rate does not reconcile", () => {
    expect(() =>
      adaptZephyrScanner(
        {
          results: [
            {
              captured_at: "2026-07-19T23:46:28.729Z",
              on_chain: {
                zsd_yield_reserve: 200,
                zys_circ: 100,
              },
              pricing_record: {
                yield_price: 1_000_000_000_000,
              },
            },
          ],
        },
        "zys-zephyr-protocol",
      ),
    ).toThrow(/share-rate divergence/);
  });
});
