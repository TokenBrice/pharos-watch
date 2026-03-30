import { describe, expect, it } from "vitest";
import type { ReportCard, StablecoinData } from "@shared/types";
import {
  filterStablecoinsByBlacklistStatus,
  getBlacklistStatusBucketForStablecoin,
  resolveBlacklistStatusBucket,
} from "@/lib/blacklist-status-buckets";

describe("blacklist status buckets", () => {
  it("maps resolved blacklist statuses into chart bucket keys", () => {
    expect(resolveBlacklistStatusBucket(true)).toBe("yes");
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

    expect(
      filterStablecoinsByBlacklistStatus(stablecoins, "yes", reportCards).map((coin) => coin.id),
    ).toEqual(["usdt-tether"]);
    expect(
      filterStablecoinsByBlacklistStatus(stablecoins, "upstream", reportCards).map((coin) => coin.id),
    ).toEqual(["usdp-parallel"]);
    expect(
      filterStablecoinsByBlacklistStatus(stablecoins, "no", reportCards).map((coin) => coin.id),
    ).toEqual(["lusd-liquity"]);
  });
});
