import { describe, expect, it } from "vitest";
import { adaptZephyrScanner, buildZephyrReserveSlice } from "../zephyr-scanner";
import { expectValidAdapterOutput, runAdapter } from "./reserve-adapter.test-support";

const ZEPHYR_ENDPOINT = "https://zephyrprotocol.com/api/v1/reservesnapshots?limit=1&order=desc";
const ZEPHYR_CAPTURE = {
  total: 580,
  limit: 1,
  order: "desc",
  results: [
    {
      captured_at: "2024-03-09T16:00:00.000Z",
      reserve_height: 773828,
      previous_height: 773827,
      hf_version: 11,
      on_chain: {
        zeph_reserve_atoms: "3838581055538091486",
        zeph_reserve: 3_838_581.055538091,
        zsd_circ_atoms: "385036812914440613",
        zsd_circ: 385_036.8129144406,
        reserve_ratio: 3.173356,
        reserve_ratio_ma: 3.218013,
        zsd_yield_reserve_atoms: "315747159842202047",
        zsd_yield_reserve: 315_747.159842202,
      },
      pricing_record: {
        spot: 318310060000,
        timestamp: 1710000000,
        reserve_ratio: 3173355150000,
        reserve_ratio_ma: 3218168250000,
      },
      raw: {
        assets: "1221858966103193233",
        liabilities: "385036812914440613",
        zeph_reserve: "3838581055538091486",
        num_stables: "385036812914440613",
        zyield_reserve: "315747159842202047",
        reserve_ratio: "3.173356",
        reserve_ratio_ma: "3.218013",
      },
    },
  ],
};

describe("adaptZephyrScanner", () => {
  it("maps latest reserve snapshot into a ZEPH protocol reserve slice with verified metadata", () => {
    const result = adaptZephyrScanner({
      total: 580,
      limit: 1,
      order: "desc",
      results: [
        {
          captured_at: "2024-03-09T16:00:00.000Z",
          reserve_height: 773828,
          previous_height: 773827,
          hf_version: 11,
          on_chain: {
            zeph_reserve_atoms: "3838581055538091486",
            zeph_reserve: 3_838_581.055538091,
            zsd_circ_atoms: "385036812914440613",
            zsd_circ: 385_036.8129144406,
            reserve_ratio: 3.173356,
            reserve_ratio_ma: 3.218013,
            zsd_yield_reserve_atoms: "315747159842202047",
            zsd_yield_reserve: 315_747.159842202,
          },
          pricing_record: {
            spot: 318310060000,
            timestamp: 1710000000,
            reserve_ratio: 3173355150000,
            reserve_ratio_ma: 3218168250000,
          },
          raw: {
            assets: "1221858966103193233",
            liabilities: "385036812914440613",
            zeph_reserve: "3838581055538091486",
            num_stables: "385036812914440613",
            zyield_reserve: "315747159842202047",
            reserve_ratio: "3.173356",
            reserve_ratio_ma: "3.218013",
          },
        },
      ],
    });

    expect(result.slices).toEqual([buildZephyrReserveSlice()]);
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

  it("passes the registered adapter output validator for timestamped snapshots", () => {
    const result = adaptZephyrScanner({
      results: [
        {
          captured_at: "2024-03-09T16:00:00.000Z",
          on_chain: {
            zeph_reserve: 1000,
            zsd_circ: 500,
            reserve_ratio: 2,
          },
          pricing_record: {
            spot: 1000000000000,
          },
        },
      ],
    });
    expectValidAdapterOutput("zephyr-scanner", result);
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
      sourceTimestamp: 1784504788,
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
describe("fetchZephyrScannerReserves", () => {
  it("fetches the catalog snapshot through the shared network boundary", async () => {
    const { result } = await runAdapter("zephyr-scanner", "zsd-zephyr-protocol", {
      network: { json: { [ZEPHYR_ENDPOINT]: ZEPHYR_CAPTURE } },
      nowSec: 1_710_003_600,
    });

    expect(result.metadata).toMatchObject({
      sourceTimestamp: 1_710_000_000,
      freshnessMode: "verified",
      reserveHeight: 773_828,
    });
  });

  it("fails closed when a snapshot drops the circulating-supply field", async () => {
    // Upstream ships each quantity in paired encodings (verified live: zsd_circ === zsd_circ_atoms / 10^12),
    // and raw.num_stables / raw.liabilities carry the same circulating-supply datum. Dropping one
    // encoding alone must still publish; only a snapshot missing every encoding is a dropped field.
    const capture = ZEPHYR_CAPTURE.results[0]!;
    const drifted = {
      ...ZEPHYR_CAPTURE,
      results: [{
        ...capture,
        on_chain: { ...capture.on_chain, zsd_circ: undefined, zsd_circ_atoms: undefined },
        raw: { ...capture.raw, num_stables: undefined, liabilities: undefined },
      }],
    };
    await expect(runAdapter("zephyr-scanner", "zsd-zephyr-protocol", {
      network: { json: { [ZEPHYR_ENDPOINT]: drifted } },
      nowSec: 1_710_003_600,
      validate: false,
    })).rejects.toThrow(/ZSD supply USD|zsd_circ/);
  });
});
