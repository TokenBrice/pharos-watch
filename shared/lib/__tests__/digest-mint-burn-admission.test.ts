import { describe, expect, it } from "vitest";
import { getMintBurnPressureRejection, isMaterialDigestGaugeShare } from "../digest-mint-burn-admission";

const DAY = 86_400;
const END = 1_792_800_000;
const evidence = {
  net24hUsd: -25_000_000,
  gaugeWeightUsd: 100_000_000,
  window: { start: END - DAY + 8 * 3600, end: END + 8 * 3600 },
  previous: { snapshotDate: END - DAY, circulatingUsd: 100_000_000 },
  current: { snapshotDate: END, circulatingUsd: 87_500_000 },
};

describe("digest mint/burn admission", () => {
  it("drops the USG inventory burn against flat circulating supply", () => {
    expect(getMintBurnPressureRejection({
      ...evidence, net24hUsd: -36_850_000, gaugeWeightUsd: 3_860_000,
      previous: { ...evidence.previous, circulatingUsd: 3_860_000 },
      current: { ...evidence.current, circulatingUsd: 3_860_000 },
    })).toBe("supply-unconfirmed");
  });

  it("requires confirmation at exactly 25%, admitting a same-direction 50% confirmation", () => {
    expect(getMintBurnPressureRejection(evidence)).toBeNull();
    expect(getMintBurnPressureRejection({ ...evidence, current: undefined })).toBe("supply-unavailable");
    expect(getMintBurnPressureRejection({ ...evidence, net24hUsd: -24_999_999, current: undefined })).toBeNull();
    expect(getMintBurnPressureRejection({ ...evidence, current: { ...evidence.current, circulatingUsd: 87_500_001 } }))
      .toBe("supply-unconfirmed");
  });

  it("confirms issuance too and preserves an observed zero supply", () => {
    expect(getMintBurnPressureRejection({ ...evidence, net24hUsd: 25_000_000,
      current: { ...evidence.current, circulatingUsd: 112_500_000 } })).toBeNull();
    expect(getMintBurnPressureRejection({ ...evidence, net24hUsd: -100_000_000,
      current: { ...evidence.current, circulatingUsd: 0 } })).toBeNull();
  });

  it.each([100_000_000, 112_500_000])("rejects flat or opposite-direction supply %s", (circulatingUsd) => {
    expect(getMintBurnPressureRejection({ ...evidence, current: { ...evidence.current, circulatingUsd } }))
      .toBe("supply-unconfirmed");
  });

  it.each([null, NaN, Infinity, -1])("keeps unavailable or invalid supply %s unavailable", (circulatingUsd) => {
    expect(getMintBurnPressureRejection({ ...evidence, current: { ...evidence.current, circulatingUsd } }))
      .toBe("supply-unavailable");
  });

  it("rejects confirmation from a recorded partial-chain remainder", () => {
    expect(getMintBurnPressureRejection({ ...evidence,
      previous: { ...evidence.previous, coverage: "partial" } })).toBe("supply-unavailable");
    expect(getMintBurnPressureRejection({ ...evidence,
      current: { ...evidence.current, coverage: "partial" } })).toBe("supply-unavailable");
  });

  it.each([null, NaN, -1])("requires an observed supply weight: %s", (gaugeWeightUsd) => {
    expect(getMintBurnPressureRejection({ ...evidence, gaugeWeightUsd })).toBe("supply-weight-unavailable");
  });

  it("rejects absent windows and gapped, stale or future history pairs", () => {
    expect(getMintBurnPressureRejection({ ...evidence, window: null })).toBe("supply-unavailable");
    for (const offset of [-DAY, DAY, -5 * 3600]) {
      expect(getMintBurnPressureRejection({ ...evidence,
        previous: { ...evidence.previous, snapshotDate: evidence.previous.snapshotDate + offset },
        current: { ...evidence.current, snapshotDate: evidence.current.snapshotDate + offset },
      })).toBe("supply-window-mismatch");
    }
    expect(getMintBurnPressureRejection({ ...evidence,
      previous: { ...evidence.previous, snapshotDate: END - 2 * DAY },
    })).toBe("supply-window-mismatch");
  });

  it.each([[3.86e6 / 67.7e9, false], [0.009999, false], [0.01, true], [1, true],
    [undefined, false], [null, false], [NaN, false], [1.1, false]] as const)(
    "gates gauge context for share %s", (share, material) => {
      expect(isMaterialDigestGaugeShare(share)).toBe(material);
    },
  );
});
