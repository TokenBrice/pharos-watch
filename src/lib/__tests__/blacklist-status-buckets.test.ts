import { describe, expect, it, vi } from "vitest";
import type { ReportCard, StablecoinData } from "@shared/types";
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
    "vcred-vcred": "dilutable",
  } as Record<string, boolean | "possible" | "inherited" | "dilutable">,
}));

vi.mock("@shared/lib/stablecoins/client-registry", () => ({
  CLIENT_ACTIVE_STABLECOINS: [{ id: "usdt-tether" }, { id: "usdp-parallel" }, { id: "lusd-liquity" }],
  CLIENT_TRACKED_META_BY_ID: new Map([
    ["usdt-tether", {}],
    ["usdp-parallel", {}],
    ["lusd-liquity", {}],
    ["vcred-vcred", {}],
  ]),
}));

vi.mock("@shared/lib/supply", () => ({
  getCirculatingRaw: (coin: StablecoinData) => coin.circulating ?? 0,
}));

vi.mock("@shared/lib/tracked-blacklist-status", () => ({
  getTrackedBlacklistStatus: (id: string) => TRACKED_STATUS_BY_ID[id] ?? null,
}));

vi.mock("@shared/lib/report-cards", () => ({
  getBlacklistStatusLabel: (status: boolean | "possible" | "inherited" | "dilutable") => {
    if (status === true) return "Yes";
    if (status === "dilutable") return "Dilutable";
    if (status === "possible") return "Possible";
    if (status === "inherited") return "Upstream";
    return "No";
  },
}));

describe("blacklist status buckets", () => {
  it("maps resolved blacklist statuses into chart bucket keys", () => {
    expect(resolveBlacklistStatusBucket(true)).toBe("yes");
    expect(resolveBlacklistStatusBucket("dilutable")).toBe("dilutable");
    expect(resolveBlacklistStatusBucket("possible")).toBe("possible");
    expect(resolveBlacklistStatusBucket("inherited")).toBe("upstream");
    expect(resolveBlacklistStatusBucket(false)).toBe("no");
  });

  it("uses report card overrides when resolving a stablecoin bucket", () => {
    const reportCard = {
      rawInputs: { canBeBlacklisted: "possible" },
    } as Pick<ReportCard, "rawInputs">;

    expect(getBlacklistStatusBucketForStablecoin("usdp-parallel", reportCard)).toBe("possible");
  });

  it("keeps local Dilutable precedence over older report-card snapshots", () => {
    const reportCard = {
      rawInputs: { canBeBlacklisted: false },
    } as Pick<ReportCard, "rawInputs">;

    expect(getBlacklistStatusBucketForStablecoin("vcred-vcred", reportCard)).toBe("dilutable");
  });

  it("always returns all five buckets, including zero market-cap rows", () => {
    const buckets = buildBlacklistStatusBuckets([], {});

    expect(buckets.map((bucket) => bucket.key)).toEqual(BLACKLIST_STATUS_BUCKET_ORDER);
    expect(buckets).toHaveLength(5);
    expect(buckets.every((bucket) => bucket.marketCap === 0)).toBe(true);
    expect(buckets.find((bucket) => bucket.key === "dilutable")).toMatchObject({ count: 0, marketCap: 0 });
    expect(buckets.find((bucket) => bucket.key === "possible")).toMatchObject({ count: 0, marketCap: 0 });
  });

  it("filters stablecoins by the selected blacklistability bucket", () => {
    const stablecoins = [
      { id: "usdt-tether", name: "Tether", symbol: "USDT" },
      { id: "usdp-parallel", name: "USD+", symbol: "USDP" },
      { id: "lusd-liquity", name: "Liquity USD", symbol: "LUSD" },
    ] as StablecoinData[];
    const reportCards = {
      "usdt-tether": { rawInputs: { canBeBlacklisted: true } },
      "usdp-parallel": { rawInputs: { canBeBlacklisted: "inherited" } },
      "lusd-liquity": { rawInputs: { canBeBlacklisted: false } },
    } as Record<string, Pick<ReportCard, "rawInputs">>;

    expect(filterStablecoinsByBlacklistStatus(stablecoins, "yes", reportCards).map((coin) => coin.id)).toEqual([
      "usdt-tether",
    ]);
    expect(filterStablecoinsByBlacklistStatus(stablecoins, "upstream", reportCards).map((coin) => coin.id)).toEqual([
      "usdp-parallel",
    ]);
    expect(filterStablecoinsByBlacklistStatus(stablecoins, "no", reportCards).map((coin) => coin.id)).toEqual([
      "lusd-liquity",
    ]);
  });
});
