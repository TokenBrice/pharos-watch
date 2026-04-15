import { describe, expect, it } from "vitest";
import { resolveCapacityBasis } from "../redemption-backstop-capacity";

describe("resolveCapacityBasis", () => {
  describe("reserve-sync-metadata model", () => {
    it("returns live-direct-telemetry when capacity confidence is live-direct", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "reserve-sync-metadata" }, "live-direct"),
      ).toBe("live-direct-telemetry");
    });

    it("returns live-proxy-buffer when capacity confidence is live-proxy", () => {
      expect(
        resolveCapacityBasis("collateral-redeem", { kind: "reserve-sync-metadata" }, "live-proxy"),
      ).toBe("live-proxy-buffer");
    });

    it("returns the explicit model.basis when confidence is neither live-direct nor live-proxy", () => {
      expect(
        resolveCapacityBasis(
          "stablecoin-redeem",
          { kind: "reserve-sync-metadata", basis: "hot-buffer" },
          "dynamic",
        ),
      ).toBe("hot-buffer");
    });

    it("falls back to live-proxy-buffer when confidence is other and no basis is set", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "reserve-sync-metadata" }, "dynamic"),
      ).toBe("live-proxy-buffer");
    });
  });

  describe("explicit model.basis on non-reserve models", () => {
    it("returns model.basis verbatim for supply-full", () => {
      expect(
        resolveCapacityBasis("stablecoin-redeem", {
          kind: "supply-full",
          basis: "daily-limit",
        }),
      ).toBe("daily-limit");
    });

    it("returns model.basis verbatim for supply-ratio", () => {
      expect(
        resolveCapacityBasis("psm-swap", {
          kind: "supply-ratio",
          ratio: 0.1,
          basis: "strategy-buffer",
        }),
      ).toBe("strategy-buffer");
    });
  });

  describe("supply-full fallbacks (no explicit basis)", () => {
    it("returns issuer-term-redemption for offchain-issuer route family", () => {
      expect(resolveCapacityBasis("offchain-issuer", { kind: "supply-full" })).toBe("issuer-term-redemption");
    });

    it("returns issuer-term-redemption for stablecoin-redeem route family", () => {
      expect(resolveCapacityBasis("stablecoin-redeem", { kind: "supply-full" })).toBe("issuer-term-redemption");
    });

    it("returns full-system-eventual for other route families", () => {
      expect(resolveCapacityBasis("basket-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("collateral-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("queue-redeem", { kind: "supply-full" })).toBe("full-system-eventual");
      expect(resolveCapacityBasis("psm-swap", { kind: "supply-full" })).toBe("full-system-eventual");
    });

    it("returns full-system-eventual when routeFamily is null (reserve-sync call-site pattern)", () => {
      expect(resolveCapacityBasis(null, { kind: "supply-full" })).toBe("full-system-eventual");
    });
  });

  describe("supply-ratio fallbacks (no explicit basis)", () => {
    it("returns psm-balance-share for psm-swap route family", () => {
      expect(
        resolveCapacityBasis("psm-swap", { kind: "supply-ratio", ratio: 0.2 }),
      ).toBe("psm-balance-share");
    });

    it("returns strategy-buffer for queue-redeem route family", () => {
      expect(
        resolveCapacityBasis("queue-redeem", { kind: "supply-ratio", ratio: 0.05 }),
      ).toBe("strategy-buffer");
    });

    it("returns hot-buffer for any other route family", () => {
      expect(
        resolveCapacityBasis("collateral-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("stablecoin-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("basket-redeem", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
      expect(
        resolveCapacityBasis("offchain-issuer", { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
    });

    it("returns hot-buffer when routeFamily is null", () => {
      expect(
        resolveCapacityBasis(null, { kind: "supply-ratio", ratio: 0.1 }),
      ).toBe("hot-buffer");
    });
  });
});
