import { describe, expect, it } from "vitest";
import { selectDigestRiskSignal } from "../digest-risk-summary";

describe("selectDigestRiskSignal", () => {
  it("prioritizes critical depegs over larger-bps small-cap watch noise", () => {
    const signal = selectDigestRiskSignal({
      activeDepegCount: 2,
      topDepegs: [
        { symbol: "SMALL", bps: -9000, mcapUsd: 100_000 },
        { symbol: "PMUSD", bps: -3000, mcapUsd: 60_000_000, impactScore: 1_800_000_000 },
      ],
    });

    expect(signal).toMatchObject({
      symbol: "PMUSD",
      bps: -3000,
      mcapUsd: 60_000_000,
      severity: "critical",
      activeCount: 2,
      date: null,
    });
  });

  it("prioritizes critical daily entries in weekly digest archives", () => {
    const signal = selectDigestRiskSignal({
      dailyDigests: [
        {
          date: "2026-06-18",
          inputData: {
            activeDepegCount: 1,
            topDepegs: [{ symbol: "SMALL", bps: -9000, mcapUsd: 100_000 }],
          },
        },
        {
          date: "2026-06-19",
          inputData: {
            activeDepegCount: 1,
            topDepegs: [{ symbol: "PMUSD", bps: -3000, mcapUsd: 60_000_000 }],
          },
        },
      ],
    });

    expect(signal).toMatchObject({
      symbol: "PMUSD",
      bps: -3000,
      mcapUsd: 60_000_000,
      severity: "critical",
      date: "2026-06-19",
    });
  });
});
