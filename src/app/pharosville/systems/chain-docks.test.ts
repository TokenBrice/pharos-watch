import { describe, expect, it } from "vitest";
import { fixtureChains } from "../__fixtures__/pharosville-world";
import { buildChainDocks } from "./chain-docks";

describe("buildChainDocks", () => {
  it("sizes docks from chain totalUsd and keeps concentration separate", () => {
    const docks = buildChainDocks(fixtureChains);

    expect(docks[0]?.chainId).toBe("ethereum");
    expect(docks[0]?.totalUsd).toBe(8_000_000_000);
    expect(docks[0]?.concentration).toBe(0.4);
    expect(docks[0]?.size).toBeGreaterThan(docks[1]?.size ?? 0);
  });
});
