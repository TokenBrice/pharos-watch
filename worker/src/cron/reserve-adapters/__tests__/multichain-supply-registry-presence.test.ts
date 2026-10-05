import { describe, expect, it } from "vitest";
import { buildChainRpcs } from "../../../lib/chain-registry";
import { chainHasRpc } from "../multichain-supply";

/**
 * Dwellir-only chains have no registry endpoint of their own: the trial key
 * creates a config for them, but its supplemental endpoints must not expand
 * the multichain aggregate's readable chain inventory.
 */
const SUPPLEMENTAL_ONLY_DWELLIR_CHAINS = ["hyperevm", "zksync", "cronos", "flow", "pulsechain", "immutable-zkevm", "boba", "astar", "taiko"] as const;

describe("chainHasRpc", () => {
  it("keeps the multichain aggregate's chain set identical with and without the Dwellir key", () => {
    const withoutKey = buildChainRpcs();
    const withKey = buildChainRpcs(undefined, undefined, { dwellirApiKey: "dwellir-test" });

    for (const chain of SUPPLEMENTAL_ONLY_DWELLIR_CHAINS) {
      expect(withoutKey.has(chain)).toBe(false);
      const config = withKey.get(chain);
      expect(config).toBeDefined();
      expect(config!.endpoints.every((endpoint) => endpoint.position === "supplemental")).toBe(true);
    }

    const chains = [...new Set([...withoutKey.keys(), ...withKey.keys()])];
    const readableWithoutKey = chains.filter((chain) => chainHasRpc(chain, { chainRpcs: withoutKey }));
    const readableWithKey = chains.filter((chain) => chainHasRpc(chain, { chainRpcs: withKey }));
    expect(readableWithKey).toEqual(readableWithoutKey);

    expect(readableWithoutKey).toContain("ethereum");
    expect(readableWithoutKey).toContain("arc");
    for (const chain of SUPPLEMENTAL_ONLY_DWELLIR_CHAINS) {
      expect(chainHasRpc(chain, { chainRpcs: withKey })).toBe(false);
    }
  });
});
