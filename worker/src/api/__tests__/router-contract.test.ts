import { describe, expect, it } from "vitest";
import { route } from "../../router";
import { mockD1 } from "./helpers/mock-d1";

const STRICT_CONTRACT_PATHS = [
  "/api/stablecoins",
  "/api/peg-summary",
  "/api/report-cards",
  "/api/stability-index",
  "/api/dex-liquidity",
  "/api/stress-signals",
  "/api/mint-burn-flows",
] as const;

const db = mockD1();
const ctx = {
  waitUntil: (_promise: Promise<unknown>) => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

describe("router contract: strict frontend paths are routable", () => {
  it("routes all strict contract paths", async () => {
    for (const path of STRICT_CONTRACT_PATHS) {
      const result = route(new URL(`https://api.pharos.watch${path}`), db, ctx);
      expect(result, `expected route for ${path}`).not.toBeNull();

      const response = await result!;
      expect(response.status, `unexpected 404 for ${path}`).not.toBe(404);
    }
  });

  it("returns null for unknown paths", () => {
    const result = route(new URL("https://api.pharos.watch/api/definitely-not-real"), db, ctx);
    expect(result).toBeNull();
  });
});
