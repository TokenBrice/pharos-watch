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
    expect(ON_CHAIN_RATE_CONFIGS).toHaveLength(62);
    // The source-ordered fixture includes XGLD's reviewed XAUt return denomination.
    expect(digest(ON_CHAIN_RATE_CONFIGS)).toBe("320bb708561a6adc1ff5eceb9d6e1b14f8dee23a33d1ccd333541a81effba3a3");
  });

  it("preserves every NAV deployment triple, trust flag and route order", () => {
    expect(navConfigs).toHaveLength(54);
    expect(navConfigs[47]).toMatchObject({ id: "stusds-sky", parentId: "usds-sky", chain: "ethereum" });
    expect(navConfigs[53]).toMatchObject({ id: "sgho-aave", parentId: "gho-aave", chain: "ethereum" });
    expect(digest(navConfigs.slice(0, 47))).toBe("046e3607bcf44822a7107c737e30db8089284367ccf2a6fd06cc739eb2e0bf61");
    expect(digest(navConfigs)).toBe("b1a01501b9094bb2d098cb9a6be6354535cb82b6e10b10b87da44c7b1ac5c986");
  });
});
