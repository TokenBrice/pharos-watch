import { describe, expect, it, vi } from "vitest";
import { makeStablecoin } from "@shared/test-utils/stablecoin";
import type { StablecoinData } from "@shared/types";
import {
  BLACKLIST_STATUS_BUCKET_ORDER,
  buildBlacklistStatusBuckets,
  filterStablecoinsByBlacklistStatus,
  getBlacklistStatusBucketForStablecoin,
  resolveBlacklistStatusBucket,
} from "@/lib/blacklist-status-buckets";

const { TRACKED_STATUS_BY_ID } = vi.hoisted(() => ({
  TRACKED_STATUS_BY_ID: {
    "usdt-tether": true,
    "usdp-parallel": "inherited",
    "lusd-liquity": false,
    "usdn-smardex": "possible",
  } as Record<string, boolean | "possible" | "inherited">,
}));

// `runtime-only` is active without reviewed metadata; `usdn-smardex` is reviewed
// but not active. Neither may reach an active bucket total.
vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_ACTIVE_STABLECOINS: [
    { id: "usdt-tether" },
    { id: "usdp-parallel" },
    { id: "lusd-liquity" },
    { id: "runtime-only" },
  ],
  CLIENT_TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { blacklistStatus: TRACKED_STATUS_BY_ID["usdt-tether"] }],
    ["usdp-parallel", { blacklistStatus: TRACKED_STATUS_BY_ID["usdp-parallel"] }],
    ["lusd-liquity", { blacklistStatus: TRACKED_STATUS_BY_ID["lusd-liquity"] }],
    ["usdn-smardex", { blacklistStatus: TRACKED_STATUS_BY_ID["usdn-smardex"] }],
  ]),
}));

const SUPPLIED_COINS: StablecoinData[] = [
  makeStablecoin({ id: "usdt-tether", circulating: { peggedUSD: 120, peggedEUR: 30 } }),
  makeStablecoin({ id: "usdp-parallel", circulating: { peggedUSD: 40 } }),
  makeStablecoin({ id: "lusd-liquity", circulating: { peggedUSD: 10, peggedEUR: 5 } }),
  makeStablecoin({ id: "usdn-smardex", circulating: { peggedUSD: 9_000 } }),
  makeStablecoin({ id: "runtime-only", circulating: { peggedUSD: 50_000 } }),
];

describe("blacklist status buckets", () => {
  it("maps resolved blacklist statuses into chart bucket keys", () => {
    expect(resolveBlacklistStatusBucket(true)).toBe("yes");
    expect(resolveBlacklistStatusBucket("possible")).toBe("possible");
    expect(resolveBlacklistStatusBucket("inherited")).toBe("upstream");
    expect(resolveBlacklistStatusBucket(false)).toBe("no");
  });

  it("uses reviewed registry status", () => {
    expect(getBlacklistStatusBucketForStablecoin("usdp-parallel")).toBe("upstream");
  });

  it("returns no status when the reviewed registry status is missing", () => {
    expect(getBlacklistStatusBucketForStablecoin("runtime-only")).toBeNull();
  });

  it("sums every circulating denomination of reviewed active coins only", () => {
    const buckets = buildBlacklistStatusBuckets(SUPPLIED_COINS);

    expect(buckets.map(({ key, count, marketCap }) => ({ key, count, marketCap }))).toEqual([
      { key: "yes", count: 1, marketCap: 150 },
      { key: "upstream", count: 1, marketCap: 40 },
      { key: "possible", count: 0, marketCap: 0 },
      { key: "no", count: 1, marketCap: 15 },
    ]);
  });

  it("counts reviewed active coins that have no runtime supply at zero market cap", () => {
    const buckets = buildBlacklistStatusBuckets([
      makeStablecoin({ id: "usdp-parallel", circulating: { peggedUSD: 40 } }),
    ]);

    expect(buckets.map(({ key, count, marketCap }) => ({ key, count, marketCap }))).toEqual([
      { key: "yes", count: 1, marketCap: 0 },
      { key: "upstream", count: 1, marketCap: 40 },
      { key: "possible", count: 0, marketCap: 0 },
      { key: "no", count: 1, marketCap: 0 },
    ]);
  });

  it("keeps registry-derived counts while zeroing market cap for empty and missing input", () => {
    for (const buckets of [buildBlacklistStatusBuckets([]), buildBlacklistStatusBuckets(undefined)]) {
      expect(buckets.map((bucket) => bucket.key)).toEqual(BLACKLIST_STATUS_BUCKET_ORDER);
      // Counts come from the reviewed registry, not the runtime supply snapshot.
      expect(buckets.map((bucket) => [bucket.count, bucket.marketCap])).toEqual([
        [1, 0],
        [1, 0],
        [0, 0],
        [1, 0],
      ]);
    }
  });

  it("filters stablecoins by the selected blacklistability bucket", () => {
    const idsFor = (status: Parameters<typeof filterStablecoinsByBlacklistStatus>[1]) =>
      filterStablecoinsByBlacklistStatus(SUPPLIED_COINS, status).map((coin) => coin.id);

    expect(idsFor("yes")).toEqual(["usdt-tether"]);
    expect(idsFor("upstream")).toEqual(["usdp-parallel"]);
    expect(idsFor("no")).toEqual(["lusd-liquity"]);
    expect(idsFor("possible")).toEqual(["usdn-smardex"]);
    expect(filterStablecoinsByBlacklistStatus(undefined, "yes")).toEqual([]);
  });
});
