import { describe, it, expect } from "vitest";
import { buildAlchemyUrl } from "../alchemy-logs";

describe("buildAlchemyUrl", () => {
  it("builds correct URL for known chains", () => {
    expect(buildAlchemyUrl("ethereum", "test-key")).toBe(
      "https://eth-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("base", "test-key")).toBe(
      "https://base-mainnet.g.alchemy.com/v2/test-key"
    );
    expect(buildAlchemyUrl("avalanche", "test-key")).toBe(
      "https://avax-mainnet.g.alchemy.com/v2/test-key"
    );
  });

  it("returns null for unknown chains", () => {
    expect(buildAlchemyUrl("tron", "test-key")).toBeNull();
    expect(buildAlchemyUrl("solana", "test-key")).toBeNull();
  });
});
