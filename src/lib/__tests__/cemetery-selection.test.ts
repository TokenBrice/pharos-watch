import { describe, expect, it } from "vitest";

import {
  buildRegisterHref,
  parseCemeteryHash,
  parseRegisterFilters,
  peakBucketOf,
} from "@/lib/cemetery-selection";

const KNOWN = new Set(["ust-terrausd-2022-05", "usdc.e-bridge", "mim-abracadabra"]);

describe("parseCemeteryHash", () => {
  it("resolves the canonical record anchor", () => {
    expect(parseCemeteryHash("#ust-terrausd-2022-05", KNOWN)).toEqual({
      kind: "record",
      id: "ust-terrausd-2022-05",
      legacy: false,
    });
    expect(parseCemeteryHash("mim-abracadabra", KNOWN)).toEqual({ kind: "record", id: "mim-abracadabra", legacy: false });
  });
});

describe("peakBucketOf", () => {
  it("buckets at the $10M, $100M and $1B thresholds", () => {
    expect(peakBucketOf(1_000_000_000)).toBe("1b-plus");
    expect(peakBucketOf(999_999_999)).toBe("100m-1b");
    expect(peakBucketOf(100_000_000)).toBe("100m-1b");
    expect(peakBucketOf(99_999_999)).toBe("10m-100m");
    expect(peakBucketOf(10_000_000)).toBe("10m-100m");
    expect(peakBucketOf(9_999_999)).toBe("under-10m");
    expect(peakBucketOf(1)).toBe("under-10m");
  });

  it("never files an unrecorded peak as small", () => {
    for (const peak of [null, undefined, Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(peakBucketOf(peak)).toBe("not-recorded");
    }
  });
});

describe("parseRegisterFilters", () => {
  it("keeps valid values", () => {
    const params = new URLSearchParams(
      "cause=abandoned&year=2022&peg=EUR&mechanism=cdp&record=tracked&peak=100m-1b&q=%20terra%20&sort=peak&dir=asc",
    );
    expect(parseRegisterFilters(params)).toEqual({
      cause: "abandoned",
      year: "2022",
      peg: "EUR",
      mechanism: "cdp",
      record: "tracked",
      peak: "100m-1b",
      q: "terra",
      sort: "peak",
      dir: "asc",
    });
  });

  it("drops invalid values", () => {
    const params = new URLSearchParams(
      "cause=rug-pull&year=22&peg=usd&mechanism=magic&record=frozen&peak=huge&q=%20%20&sort=tvl&dir=up",
    );
    expect(parseRegisterFilters(params)).toEqual({});
    expect(parseRegisterFilters(new URLSearchParams("cause=all&year=20222"))).toEqual({});
  });
});

describe("buildRegisterHref", () => {
  it("links a single facet to the register", () => {
    expect(buildRegisterHref({ cause: "abandoned" })).toBe("/cemetery/?cause=abandoned#register");
    expect(buildRegisterHref({})).toBe("/cemetery/#register");
  });
});
