import { describe, expect, it } from "vitest";
import { ACTIVE_STABLECOINS } from "@shared/lib/stablecoins/registry";
import { mockD1 } from "../../test-helpers/__shared/mock-d1";
import {
  listTelegramPresets,
  resolveTelegramPresetAlias,
  resolveTelegramPresetTargets,
} from "../telegram-presets";

function makeStablecoinsCacheValue(overrides: Record<string, number> = {}): string {
  return JSON.stringify({
    peggedAssets: [
      ...ACTIVE_STABLECOINS.map((stablecoin) => ({
        id: stablecoin.id,
        symbol: stablecoin.symbol,
        name: stablecoin.name,
        circulating: { usd: overrides[stablecoin.id] ?? 0 },
      })),
      {
        id: "usdpt-storedotfi",
        symbol: "USDPT",
        name: "USDPT",
        circulating: { usd: 99_000_000_000 },
      },
    ],
  });
}

function makeDbWithStablecoinsValue(overrides: Record<string, number> | null): D1Database {
  if (overrides == null) {
    return mockD1([{ match: "FROM cache WHERE key = ?", rows: [], first: null }]);
  }
  return mockD1([
    {
      match: "FROM cache WHERE key = ?",
      matchBinds: ["stablecoins"],
      rows: [],
      first: {
        value: makeStablecoinsCacheValue(overrides),
        updated_at: 1_700_000_000,
      },
    },
  ]);
}

describe("telegram preset catalog", () => {
  it("lists the expected v1 preset aliases", () => {
    expect(listTelegramPresets().map((preset) => preset.id)).toEqual([
      "usd-top10",
      "usd-top25",
      "usd-top50",
      "non-usd-top10",
      "non-usd-top25",
      "non-usd-top50",
      "eur-top10",
      "gold-top5",
      "mcap-ge-1b",
      "mcap-ge-100m",
    ]);
  });

  it("describes non-USD presets as mixed non-USD pegs ranked by USD market cap", () => {
    for (const preset of listTelegramPresets().filter((entry) => entry.id.startsWith("non-usd-top"))) {
      expect(preset.description).toMatch(/non-USD pegs \(fiat, gold\/silver, baskets\) by USD market cap/);
    }
  });

  it("recognizes supported preset aliases", () => {
    expect(resolveTelegramPresetAlias("usd-top25")).not.toBeNull();
    expect(resolveTelegramPresetAlias("usd-top-25")).not.toBeNull();
    expect(resolveTelegramPresetAlias("non-usd-top25")).not.toBeNull();
    expect(resolveTelegramPresetAlias("non-usd-top-25")).not.toBeNull();
    expect(resolveTelegramPresetAlias("USD-TOP25".toLowerCase())).not.toBeNull();
    expect(resolveTelegramPresetAlias("usd-top100")).toBeNull();
  });

  it("normalizes dashed aliases to canonical preset ids", () => {
    expect(resolveTelegramPresetAlias("usd-top-25")).toBe("usd-top25");
    expect(resolveTelegramPresetAlias("usd-top25")).toBe("usd-top25");
    expect(resolveTelegramPresetAlias("non-usd-top-25")).toBe("non-usd-top25");
    expect(resolveTelegramPresetAlias("USD-TOP-10")).toBe("usd-top10");
  });
});

describe("resolveTelegramPresetTargets", () => {
  it("fails closed when the stablecoins cache is unavailable", async () => {
    const db = makeDbWithStablecoinsValue(null);

    const result = await resolveTelegramPresetTargets(db, ["usd-top25"]);

    expect(result).toEqual({
      kind: "error",
      reason: "stablecoins-cache-unavailable",
    });
  });

  it("resolves market-cap presets against active tracked stablecoins only", async () => {
    const db = makeDbWithStablecoinsValue({
      "usdc-circle": 5_000_000_000,
      "dai-makerdao": 1_500_000_000,
      "eurc-circle": 450_000_000,
      "xaut-tether": 2_000_000_000,
    });

    const result = await resolveTelegramPresetTargets(db, ["mcap-ge-1b"]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.presets).toHaveLength(1);
    expect(result.presets[0]?.stablecoinIds).toEqual(
      expect.arrayContaining([
        "usdc-circle",
        "dai-makerdao",
        "xaut-tether",
      ]),
    );
    expect(result.presets[0]?.stablecoinIds).not.toContain("eurc-circle");
    expect(result.presets[0]?.stablecoinIds).not.toContain("usdpt-storedotfi");
  });

  it("orders top presets by current market cap and then canonical order", async () => {
    const db = makeDbWithStablecoinsValue({
      "pyusd-paypal": 3_000_000_000,
      "dai-makerdao": 4_000_000_000,
      "usdc-circle": 5_000_000_000,
    });

    const result = await resolveTelegramPresetTargets(db, ["usd-top10"]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.presets[0]?.stablecoinIds.slice(0, 3)).toEqual([
      "usdc-circle",
      "dai-makerdao",
      "pyusd-paypal",
    ]);
    expect(result.presets[0]?.stablecoinIds).toHaveLength(10);
  });

  it("resolves non-USD top presets against every active non-USD peg", async () => {
    const db = makeDbWithStablecoinsValue({
      "usdc-circle": 99_000_000_000,
      "usdt-tether": 98_000_000_000,
      "eurc-circle": 5_000_000_000,
      "xaut-tether": 4_000_000_000,
      "a7a5-old-vector": 3_000_000_000,
    });

    const result = await resolveTelegramPresetTargets(db, ["non-usd-top10"]);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;

    expect(result.presets[0]?.stablecoinIds.slice(0, 3)).toEqual([
      "eurc-circle",
      "xaut-tether",
      "a7a5-old-vector",
    ]);
    expect(result.presets[0]?.stablecoinIds).toHaveLength(10);
    expect(result.presets[0]?.stablecoinIds).not.toContain("usdc-circle");
    expect(result.presets[0]?.stablecoinIds).not.toContain("usdt-tether");
  });
});
