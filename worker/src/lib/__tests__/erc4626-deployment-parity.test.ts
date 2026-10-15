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
  it("preserves every rate field and deployment order, including Axis and independent precisions", () => {
    expect(ON_CHAIN_RATE_CONFIGS).toHaveLength(58);
    expect(digest(ON_CHAIN_RATE_CONFIGS)).toBe("4ae6464d8bed053c45989df8ad6430db51e4c96e50839081719e4d224e8789a0");
  });

  it("preserves every NAV deployment triple, trust flag and route order", () => {
    expect(navConfigs).toHaveLength(48);
    expect(navConfigs[47]).toMatchObject({ id: "sgho-aave", parentId: "gho-aave", chain: "ethereum" });
    expect(digest(navConfigs.slice(0, 47))).toBe("c1aa4523519aebc977bcc3fa6bc1bfb33c30df63d7d9a3cd1e42535cc55c89fb");
  });
});
