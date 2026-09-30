import { describe, expect, it } from "vitest";
import { CEMETERY_ENTRIES } from "@shared/lib/cemetery-merged";
import {
  CEMETERY_PEAK_BUCKET_KEYS,
  CEMETERY_REGISTER_QUERY_MAX_LENGTH,
  buildRegisterHref,
  findCemeteryIdCollisions,
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

  it("resolves the legacy obituary alias", () => {
    expect(parseCemeteryHash("#obituary-mim-abracadabra", KNOWN)).toEqual({
      kind: "record",
      id: "mim-abracadabra",
      legacy: true,
    });
  });

  it("decodes URL-encoded ids", () => {
    expect(parseCemeteryHash("#usdc%2Ee-bridge", KNOWN)).toEqual({ kind: "record", id: "usdc.e-bridge", legacy: false });
    expect(parseCemeteryHash("#obituary-usdc%2Ee-bridge", KNOWN)).toEqual({
      kind: "record",
      id: "usdc.e-bridge",
      legacy: true,
    });
    expect(parseCemeteryHash("#%E0%A4%A", KNOWN)).toBeNull();
  });

  it("classifies section anchors and cause anchors as sections, never records", () => {
    expect(parseCemeteryHash("#register", KNOWN)).toEqual({ kind: "section", anchor: "register" });
    expect(parseCemeteryHash("#key-facts", KNOWN)).toEqual({ kind: "section", anchor: "key-facts" });
    expect(parseCemeteryHash("#cause-abandoned", KNOWN)).toEqual({ kind: "section", anchor: "cause-abandoned" });
    expect(parseCemeteryHash("#cause-rug-pull", KNOWN)).toBeNull();
  });

  it("ignores unknown ids and empty hashes", () => {
    expect(parseCemeteryHash("#not-a-coin", KNOWN)).toBeNull();
    expect(parseCemeteryHash("#obituary-not-a-coin", KNOWN)).toBeNull();
    expect(parseCemeteryHash("#grave-mim-abracadabra", KNOWN)).toBeNull();
    expect(parseCemeteryHash("#", KNOWN)).toBeNull();
    expect(parseCemeteryHash("", KNOWN)).toBeNull();
  });
});

describe("findCemeteryIdCollisions", () => {
  it("finds no collisions among the real cemetery ids", () => {
    expect(findCemeteryIdCollisions(CEMETERY_ENTRIES.map((entry) => entry.id))).toEqual([]);
  });

  it("flags section anchors and reserved prefixes", () => {
    expect(
      findCemeteryIdCollisions(["faq", "grave-x", "walk-x", "obituary-x", "autopsy-x", "cause-x", "usdt-tether", "faq"]),
    ).toEqual(["faq", "grave-x", "walk-x", "obituary-x", "autopsy-x", "cause-x"]);
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

  it("assigns every real entry to a declared bucket", () => {
    for (const entry of CEMETERY_ENTRIES) {
      expect(CEMETERY_PEAK_BUCKET_KEYS).toContain(peakBucketOf(entry.peakMcap));
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

  it("bounds the search text", () => {
    const q = "x".repeat(CEMETERY_REGISTER_QUERY_MAX_LENGTH + 20);
    expect(parseRegisterFilters(new URLSearchParams({ q })).q).toHaveLength(CEMETERY_REGISTER_QUERY_MAX_LENGTH);
  });
});

describe("buildRegisterHref", () => {
  it("links a single facet to the register", () => {
    expect(buildRegisterHref({ cause: "abandoned" })).toBe("/cemetery/?cause=abandoned#register");
    expect(buildRegisterHref({})).toBe("/cemetery/#register");
  });

  it("orders params canonically regardless of input order", () => {
    expect(buildRegisterHref({ dir: "asc", q: "terra usd", cause: "regulatory", peak: "1b-plus", year: "2023" })).toBe(
      "/cemetery/?cause=regulatory&year=2023&peak=1b-plus&q=terra+usd&dir=asc#register",
    );
  });

  it("replaces register params in the base and preserves unrelated ones", () => {
    const base = new URLSearchParams("utm_source=feed&cause=abandoned&year=2021&ref=rss");
    expect(buildRegisterHref({ cause: "liquidity-drain" }, { base })).toBe(
      "/cemetery/?cause=liquidity-drain&utm_source=feed&ref=rss#register",
    );
  });

  it("drops invalid values and honours pathname and hash options", () => {
    const filters = { cause: "rug-pull", year: "1999x" } as unknown as Parameters<typeof buildRegisterHref>[0];
    expect(buildRegisterHref(filters, { pathname: "/cemetery/", hash: null })).toBe("/cemetery/");
    expect(buildRegisterHref({ record: "curated" }, { hash: "cause-abandoned" })).toBe(
      "/cemetery/?record=curated#cause-abandoned",
    );
  });

  it("round-trips through parseRegisterFilters", () => {
    const filters = { cause: "algorithmic-failure", mechanism: "algorithmic", sort: "died", dir: "desc" } as const;
    const href = buildRegisterHref(filters);
    const search = href.slice(href.indexOf("?"), href.indexOf("#"));
    expect(parseRegisterFilters(new URLSearchParams(search))).toEqual(filters);
  });
});
