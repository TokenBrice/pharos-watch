import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Erc4626NavVaultConfig } from "../authoritative-price-sources/helpers";
import type * as NavHelpers from "../authoritative-price-sources/helpers";
import { ON_CHAIN_RATE_CONFIGS } from "../yield-config/yield-config-rate-sources";

const { navConfigs } = vi.hoisted(() => ({ navConfigs: [] as Erc4626NavVaultConfig[] }));
vi.mock("../authoritative-price-sources/helpers", async (importOriginal) => {
  const helpers = await importOriginal<typeof NavHelpers>();
  return {
    ...helpers,
    defineRegistryErc4626NavVault: (input: Parameters<typeof helpers.defineRegistryErc4626NavVault>[0]) => {
      const config = helpers.defineRegistryErc4626NavVault(input);
      navConfigs.push(config);
      return config;
    },
  };
});
import "../authoritative-price-sources/erc4626-nav";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

describe("ERC-4626 deployment parity", () => {
  it("preserves every rate field in deterministic source order, including Axis and independent precisions", () => {
    expect(ON_CHAIN_RATE_CONFIGS).toHaveLength(58);
    // The source-ordered fixture includes XGLD's reviewed XAUt return denomination.
    expect(digest(ON_CHAIN_RATE_CONFIGS)).toBe("112e553c307b65a6645e9c27e30bb7c4109989c4e3ae161cc97f2e032d4a1bad");
  });

  it("preserves every NAV deployment triple, trust flag and route order", () => {
    expect(navConfigs).toHaveLength(48);
    expect(navConfigs[47]).toMatchObject({ id: "sgho-aave", parentId: "gho-aave", chain: "ethereum" });
    expect(digest(navConfigs.slice(0, 47))).toBe("046e3607bcf44822a7107c737e30db8089284367ccf2a6fd06cc739eb2e0bf61");
  });
});
