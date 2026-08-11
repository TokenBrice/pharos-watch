import { describe, expect, it, vi } from "vitest";
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

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_ACTIVE_STABLECOINS: [{ id: "usdt-tether" }, { id: "usdp-parallel" }, { id: "lusd-liquity" }],
  CLIENT_TRACKED_META_BY_ID: new Map([
    ["usdt-tether", { blacklistStatus: TRACKED_STATUS_BY_ID["usdt-tether"] }],
    ["usdp-parallel", { blacklistStatus: TRACKED_STATUS_BY_ID["usdp-parallel"] }],
    ["lusd-liquity", { blacklistStatus: TRACKED_STATUS_BY_ID["lusd-liquity"] }],
    ["usdn-smardex", { blacklistStatus: TRACKED_STATUS_BY_ID["usdn-smardex"] }],
  ]),
}));

vi.mock("@shared/lib/supply", () => ({
  getCirculatingRaw: (coin: StablecoinData) => coin.circulating ?? 0,
}));

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

  it("always returns all four buckets, including zero market-cap rows", () => {
    const buckets = buildBlacklistStatusBuckets([]);

    expect(buckets.map((bucket) => bucket.key)).toEqual(BLACKLIST_STATUS_BUCKET_ORDER);
    expect(buckets).toHaveLength(4);
    expect(buckets.every((bucket) => bucket.marketCap === 0)).toBe(true);
    expect(buckets.find((bucket) => bucket.key === "possible")).toMatchObject({ count: 0, marketCap: 0 });
  });

  it("filters stablecoins by the selected blacklistability bucket", () => {
    const stablecoins = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT" },
      { id: "usdp-parallel", name: "USD+", symbol: "USDP" },
      { id: "lusd-liquity", name: "Liquity USD", symbol: "LUSD" },
    ] as StablecoinData[];
    expect(filterStablecoinsByBlacklistStatus(stablecoins, "yes").map((coin) => coin.id)).toEqual([
      "usdt-tether",
    ]);
    expect(filterStablecoinsByBlacklistStatus(stablecoins, "upstream").map((coin) => coin.id)).toEqual([
      "usdp-parallel",
    ]);
    expect(filterStablecoinsByBlacklistStatus(stablecoins, "no").map((coin) => coin.id)).toEqual([
      "lusd-liquity",
    ]);
  });
});
