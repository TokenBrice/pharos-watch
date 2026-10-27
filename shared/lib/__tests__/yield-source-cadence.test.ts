import { describe, expect, it } from "vitest";
import { CRON_INTERVALS } from "../cron-jobs";
import { getYieldSourceProducerCadenceMs } from "../yield-source-cadence";

const DAY_MS = 86_400_000;

describe("getYieldSourceProducerCadenceMs", () => {
  it("resolves each source class to its producer cadence", () => {
    expect(getYieldSourceProducerCadenceMs("defillama", "defillama:pool")).toBe(CRON_INTERVALS["sync-yield-data"] * 1000);
    expect(getYieldSourceProducerCadenceMs("onchain", "erc4626:vault")).toBe(CRON_INTERVALS["sync-yield-data"] * 1000);
    expect(getYieldSourceProducerCadenceMs("protocol-api", "protocol-api:ethena")).toBe(
      CRON_INTERVALS["sync-yield-supplemental"] * 1000,
    );
    expect(getYieldSourceProducerCadenceMs("onchain", "compound-v3:usdc")).toBe(
      CRON_INTERVALS["sync-yield-supplemental"] * 1000,
    );
    expect(getYieldSourceProducerCadenceMs("protocol-api", "protocol-api:pendle:abc")).toBe(DAY_MS);
    expect(getYieldSourceProducerCadenceMs("protocol-api", "protocol-api:hashnote-usyc")).toBe(DAY_MS);
    expect(getYieldSourceProducerCadenceMs("price-derived")).toBe(DAY_MS);
    expect(getYieldSourceProducerCadenceMs("rate-derived")).toBe(DAY_MS);
  });
});
