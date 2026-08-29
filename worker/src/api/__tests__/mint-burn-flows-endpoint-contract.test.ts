import { readJsonResponse } from "../../test-helpers/__shared/auth";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerStablecoinParameterContract } from "../../test-helpers/__shared/endpoint-contracts";
import { mintBurnScenario } from "../../test-helpers/__shared/mint-burn";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { MintBurnFlowsResponseSchema, MintBurnPerCoinResponseSchema } from "@shared/types/mint-burn";

// ---------------------------------------------------------------------------
// Contract tests (handler-level, using D1 mock)
// ---------------------------------------------------------------------------

describe("handleMintBurnFlows contract tests", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const nowSec = Math.floor(Date.now() / 1000);

  const hourlyRow = {
    stablecoin_id: "usdt-tether",
    chain_id: "ethereum",
    hour_ts: nowSec - 3600,
    mint_count: 5,
    burn_count: 3,
    mint_volume_usd: 10000,
    burn_volume_usd: 5000,
    net_flow_usd: 5000,
  };

  const stablecoinsCache = JSON.stringify({
    peggedAssets: [{ id: "usdt-tether", symbol: "USDT", circulating: { peggedUSD: 100000000000 } }],
  });

  const db = mintBurnScenario({
    nowSec,
    rows: { hourly: [hourlyRow] },
    stablecoinsCache: { value: stablecoinsCache, updatedAt: nowSec },
  });

  it("aggregate mode returns shape matching MintBurnFlowsResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows");
    const res = await handleMintBurnFlows(db, url);

    const body = (await readJsonResponse(res, 200)) as Record<string, unknown>;

    // Cross-validate against the same Zod schema the frontend uses
    const parsed = MintBurnFlowsResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions
    expect(body).toHaveProperty("gauge");
    expect(body).toHaveProperty("coins");
    expect(body).toHaveProperty("hourly");
    expect(Array.isArray(body.coins)).toBe(true);
    expect(body).not.toHaveProperty("stablecoinId");
  });

  it("per-coin mode returns shape matching MintBurnPerCoinResponseSchema", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=usdt-tether");
    const res = await handleMintBurnFlows(db, url);

    const body = await readJsonResponse(res, 200);

    // Cross-validate against per-coin schema
    const parsed = MintBurnPerCoinResponseSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Structural assertions — NOT aggregate shape
    expect(body).toHaveProperty("stablecoinId");
    expect(body).toHaveProperty("chains");
    expect(body).not.toHaveProperty("coins");
    expect(body).not.toHaveProperty("gauge");
  });

  registerStablecoinParameterContract({
    name: "mint/burn flows",
    path: "/api/mint-burn-flows",
    invoke: handleMintBurnFlows,
    cases: [{ kind: "unknown", stablecoin: "99999" }],
  });

  it("returns 404 for a valid stablecoin that is not tracked for mint/burn flows", async () => {
    const url = new URL("https://x/api/mint-burn-flows?stablecoin=susdai-usd-ai");
    const res = await handleMintBurnFlows(db, url);

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({
      error: 'Stablecoin "susdai-usd-ai" is not tracked for mint/burn flows',
    });
  });

  it("rejects out-of-range hours instead of clamping them", async () => {
    const res = await handleMintBurnFlows(db, new URL("https://x/api/mint-burn-flows?hours=9999"));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: "Invalid hours: must be between 1 and 720" });
  });

  it("returns 503 when stablecoins cache is unavailable and no flow fallback cache exists", async () => {
    const res = await handleMintBurnFlows(
      mintBurnScenario({ stablecoinsCache: null }),
      new URL("https://x/api/mint-burn-flows"),
    );

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: "Stablecoins data not yet available",
    });
  });
});
