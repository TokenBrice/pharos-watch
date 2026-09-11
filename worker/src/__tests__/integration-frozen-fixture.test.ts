import { describe, expect, it, vi } from "vitest";
import { mockD1 } from "@shared/test-utils/mock-d1";
import { makeApiRequest } from "../test-helpers/__shared/auth";
import type * as AlchemyLogs from "../lib/alchemy-logs";

// Keep the real registry derivation and lifecycle predicates; replace only its input catalog.
vi.mock("@shared/data/stablecoins/canonical-order.json", () => ({ default: ["fixture-active", "fixture-frozen"] }));
vi.mock("@shared/data/stablecoins/coins.generated.json", async () => {
  // The hoisted catalog mock must load its builder before static test imports initialize.
  const { makeStablecoinMeta } = await import("@shared/test-utils/stablecoin");
  return { default: [
    makeStablecoinMeta({ id: "fixture-active", status: "active" }),
    makeStablecoinMeta({
      id: "fixture-frozen",
      status: "frozen",
      reserves: [{ name: "Archived Treasury holdings", pct: 100, risk: "low" }],
      liveReservesConfig: {
        adapter: "infinifi", version: 1, semantics: "protocol-reserve",
        inputs: { primary: { kind: "http-json", url: "https://example.com/reserves" } },
      },
    }),
  ] };
});
vi.mock("../lib/mint-burn-contracts", () => ({
  MINT_BURN_CONFIGS: [{
    stablecoinId: "fixture-frozen",
    chain: { chainId: "ethereum" },
    contractAddress: "0x0000000000000000000000000000000000000001",
  }],
}));
vi.mock("../lib/alchemy-logs", async (importOriginal) => ({
  ...await importOriginal<typeof AlchemyLogs>(),
  getAlchemyBlockNumber: vi.fn(async () => 22_000_000),
}));

import { shouldCloseOrphanedDepeg } from "../cron/depeg-detection/repair";
import { computeDexPruneSet } from "../cron/dex-liquidity/persistence";
import { computeStressSignalPruneIds } from "../lib/dews/persistence";
import { PSI_ELIGIBLE_IDS } from "@shared/lib/psi-eligible";
import { handleStablecoinReserves } from "../api/stablecoin-reserves";
import { handleBackfillMintBurn } from "../api/backfill-mint-burn";

describe("frozen lifecycle consumers", () => {
  it("orphan-close policy preserves frozen coins but closes missing active coins", () => {
    expect(shouldCloseOrphanedDepeg("fixture-frozen", new Set())).toBe(false);
    expect(shouldCloseOrphanedDepeg("fixture-active", new Set())).toBe(true);
  });

  it("backfill handler rejects a frozen configured coin without database writes", async () => {
    const request = makeApiRequest("/api/backfill-mint-burn", {
      method: "POST",
      adminKey: "operator",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ configKey: "ethereum-0x0000000000000000000000000000000000000001" }),
    });
    const db = mockD1([], { requireMatch: true });
    const response = await handleBackfillMintBurn({
      db, request, url: new URL(request.url), trustedAdmin: true, alchemyApiKey: "alchemy-key",
    });
    expect(response.status).toBe(403);
    expect(db.getHistory()).toEqual([]);
  });

  it("DEX prune policy preserves frozen coins and removes unknown coins", () => {
    expect(computeDexPruneSet(new Set(["fixture-frozen", "zombie-coin"]))).toEqual(new Set(["zombie-coin"]));
  });

  it("DEWS prune policy preserves frozen coins and removes unknown coins", () => {
    expect(computeStressSignalPruneIds(new Set(["fixture-frozen", "zombie"]), new Set())).toEqual(new Set(["zombie"]));
  });

  it("PSI eligibility includes the active control and excludes the frozen control", () => {
    expect(PSI_ELIGIBLE_IDS.has("fixture-active")).toBe(true);
    expect(PSI_ELIGIBLE_IDS.has("fixture-frozen")).toBe(false);
  });

  it("reserves handler reads preserved reserve data for a frozen coin", async () => {
    const db = mockD1([
      { match: "FROM reserve_composition", matchBinds: ["fixture-frozen"], rows: [] },
      { match: "FROM reserve_sync_state", matchBinds: ["fixture-frozen"], rows: [] },
    ], { requireMatch: true });
    const response = await handleStablecoinReserves(db, "fixture-frozen");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stablecoinId: "fixture-frozen",
      mode: "curated-fallback",
      reserves: [{ name: "Archived Treasury holdings", pct: 100, risk: "low" }],
    });
  });
});
