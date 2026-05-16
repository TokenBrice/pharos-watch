import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "../stablecoins/registry";
import {
  LiveReservesConfigSchema,
  parseLiveReserveAdapterParams,
} from "../live-reserve-adapters";
import { baseLiveReserveConfigSchema } from "../live-reserve-adapters-schemas";

describe("baseLiveReserveConfigSchema", () => {
  it("accepts a non-empty breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "my-scope",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an omitted breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an empty-string breakerScope", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      breakerScope: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-absolute display URLs", () => {
    const result = baseLiveReserveConfigSchema.safeParse({
      version: 1,
      semantics: "collateral-mix",
      display: {
        url: "/reserve-dashboard",
      },
    });
    expect(result.success).toBe(false);
  });
});

describe("LiveReservesConfigSchema URL validation", () => {
  it("rejects non-absolute input URLs", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "accountable",
      version: 1,
      semantics: "protocol-reserve",
      inputs: {
        primary: { kind: "http-json", url: "/api/reserves" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects non-absolute URL params", () => {
    expect(() => parseLiveReserveAdapterParams("btcfi", {
      handlersUrl: "/api/reserve-handlers",
    })).toThrow(/Invalid URL/);
  });

  it("accepts configured live reserve URLs", () => {
    const failures: string[] = [];

    for (const coin of ACTIVE_STABLECOINS) {
      if (!coin.liveReservesConfig) continue;
      const parsed = LiveReservesConfigSchema.safeParse(coin.liveReservesConfig);
      if (!parsed.success) {
        failures.push(`${coin.id}: ${parsed.error.issues[0]?.path.join(".") ?? "config"} ${parsed.error.issues[0]?.message ?? "invalid"}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("LiveReservesConfigSchema adapter policy validation", () => {
  it("rejects unsupported adapter semantics", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "chainlink-por",
      version: 1,
      semantics: "collateral-mix",
      inputs: {
        primary: { kind: "onchain-evm", chain: "ethereum", rpcMode: "public-rpc" },
      },
    });

    expect(result.success).toBe(false);
  });

  it("rejects unsupported adapter config versions", () => {
    const result = LiveReservesConfigSchema.safeParse({
      adapter: "accountable",
      version: 99,
      semantics: "protocol-reserve",
      inputs: {
        primary: { kind: "http-json", url: "https://example.com/reserves" },
      },
    });

    expect(result.success).toBe(false);
  });
});
