import { describe, expect, it } from "vitest";
import { selectTrendBaseline } from "../dex-liquidity-response";

describe("selectTrendBaseline", () => {
  it("uses the nearest eligible row and ignores low-confidence history", () => {
    const targetSec = 1_700_000_000;
    const history = [
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 200,
        snapshot_date: targetSec - 60,
        coverage_class: "primary",
        coverage_confidence: 0.4,
      },
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 100,
        snapshot_date: targetSec - 120,
        coverage_class: "primary",
        coverage_confidence: 0.9,
      },
    ];

    expect(selectTrendBaseline(history, targetSec, 12 * 3600)).toEqual(history[1]);
  });

  it("rejects rows outside the trend tolerance window", () => {
    const targetSec = 1_700_000_000;
    const history = [
      {
        stablecoin_id: "usdt-tether",
        total_tvl_usd: 100,
        snapshot_date: targetSec - 13 * 3600,
        coverage_class: "primary",
        coverage_confidence: 0.9,
      },
    ];

    expect(selectTrendBaseline(history, targetSec, 12 * 3600)).toBeNull();
  });
});
