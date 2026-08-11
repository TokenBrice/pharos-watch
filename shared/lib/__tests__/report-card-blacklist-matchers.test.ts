import { describe, expect, it } from "vitest";
import {
  getBlacklistStatusLabel,
  resolveBlacklistStatus,
  resolveBlacklistStatuses,
} from "../report-card-blacklist-matchers";
import type { StablecoinMeta } from "../../types";

function makeMeta(
  id: string,
  reviewedStatus?: NonNullable<StablecoinMeta["blacklistabilityReview"]>["reviewedStatus"],
): StablecoinMeta {
  return {
    id,
    name: id,
    symbol: id.toUpperCase(),
    flags: {
      backing: "crypto-backed",
      governance: "decentralized",
      pegCurrency: "USD",
      yieldBearing: false,
      rwa: false,
      navToken: false,
    },
    ...(reviewedStatus === undefined
      ? {}
      : {
          blacklistabilityReview: {
            reviewedStatus,
            sourceFreeRationale: "Test fixture review.",
            evidence: "Test fixture blacklistability evidence.",
            reviewer: "Test",
            reviewedAt: "2026-08-11",
          },
        }),
  };
}

describe("reviewed blacklist status", () => {
  it.each([
    [true, "Yes"],
    ["inherited", "Upstream"],
    ["possible", "Possible"],
    [false, "No"],
  ] as const)("projects %s without inference", (status, label) => {
    expect(resolveBlacklistStatus(makeMeta(String(status), status))).toBe(status);
    expect(getBlacklistStatusLabel(status)).toBe(label);
  });

  it("projects the catalog without changing input order or status", () => {
    const metas = [makeMeta("upstream", "inherited"), makeMeta("direct", true)];
    expect([...resolveBlacklistStatuses(metas)]).toEqual([
      ["upstream", "inherited"],
      ["direct", true],
    ]);
  });

  it("fails closed when the canonical review is missing", () => {
    expect(() => resolveBlacklistStatus(makeMeta("missing"))).toThrow(
      "Stablecoin missing has no reviewed blacklistability status",
    );
  });
});
