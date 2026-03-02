/**
 * Regression snapshot test for API handler refactoring.
 *
 * Captures HTTP status codes returned by each handler under "no data" (empty DB)
 * conditions. Any change in status codes after mechanical refactoring signals a
 * behavioral regression.
 */
import { describe, it, expect } from "vitest";
import { mockD1 } from "./helpers/mock-d1";

// --- Public handlers: db only ---
import { handleHealth } from "../health";
import { handleDailyDigest } from "../daily-digest";
import { handleDexLiquidity } from "../dex-liquidity";
import { handlePegSummary } from "../peg-summary";
import { handleReportCards } from "../report-cards";
import { handleDigestArchive } from "../digest-archive";

// --- Public handlers: db + url ---
import { handleBlacklist } from "../blacklist";
import { handleDepegEvents } from "../depeg-events";
import { handleSupplyHistory } from "../supply-history";
import { handleDexLiquidityHistory } from "../dex-liquidity-history";
import { handleYieldHistory } from "../yield-history";
import { handleStabilityIndex } from "../stability-index";
import { handleStressSignals } from "../stress-signals";
import { handleMintBurnFlows } from "../mint-burn-flows";
import { handleMintBurnEvents } from "../mint-burn-events";
import { handleDigestSnapshot } from "../digest-snapshot";

// --- Cache-passthrough handlers (included for completeness) ---
import { handleStablecoins } from "../stablecoins";
import { handleStablecoinCharts } from "../stablecoin-charts";
import { handleUsdsStatus } from "../usds-status";
import { handleBluechipRatings } from "../bluechip";
import { handleYieldRankings } from "../yield-rankings";

const emptyDb = mockD1();
const baseUrl = new URL("https://api.pharos.watch/api/test");

describe("Regression: handler status codes with empty DB", () => {
  // --- db-only handlers ---

  it("handleHealth → 200", async () => {
    const res = await handleHealth(emptyDb);
    expect(res.status).toBe(200);
  });

  it("handleDailyDigest → 200 (digest: null)", async () => {
    const res = await handleDailyDigest(emptyDb);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("digest", null);
  });

  it("handleDexLiquidity → 200", async () => {
    const res = await handleDexLiquidity(emptyDb);
    expect(res.status).toBe(200);
  });

  it("handlePegSummary → 503 (needs stablecoins cache)", async () => {
    const res = await handlePegSummary(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleReportCards → 503 (needs stablecoins cache)", async () => {
    const res = await handleReportCards(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleDigestArchive → 200", async () => {
    const res = await handleDigestArchive(emptyDb);
    expect(res.status).toBe(200);
    const body = await res.json() as { digests: unknown[] };
    expect(body).toHaveProperty("digests");
    expect(body.digests).toEqual([]);
  });

  // --- db + url handlers (no query params → expected behavior) ---

  it("handleBlacklist → 200 (empty results)", async () => {
    const res = await handleBlacklist(emptyDb, baseUrl);
    expect(res.status).toBe(200);
  });

  it("handleDepegEvents → 200 (empty results)", async () => {
    const res = await handleDepegEvents(emptyDb, baseUrl);
    expect(res.status).toBe(200);
  });

  it("handleSupplyHistory → 400 (missing stablecoin param)", async () => {
    const res = await handleSupplyHistory(emptyDb, baseUrl);
    expect(res.status).toBe(400);
  });

  it("handleDexLiquidityHistory → 400 (missing stablecoin param)", async () => {
    const res = await handleDexLiquidityHistory(emptyDb, baseUrl);
    expect(res.status).toBe(400);
  });

  it("handleYieldHistory → 400 (missing stablecoin param)", async () => {
    const res = await handleYieldHistory(emptyDb, baseUrl);
    expect(res.status).toBe(400);
  });

  it("handleStabilityIndex → 200", async () => {
    const res = await handleStabilityIndex(emptyDb, baseUrl);
    expect(res.status).toBe(200);
  });

  it("handleStressSignals → 200 (all signals)", async () => {
    const res = await handleStressSignals(emptyDb, baseUrl);
    expect(res.status).toBe(200);
  });

  it("handleMintBurnFlows → 200 (all flows)", async () => {
    const res = await handleMintBurnFlows(emptyDb, baseUrl);
    expect(res.status).toBe(200);
  });

  it("handleMintBurnEvents → 400 (missing stablecoin param)", async () => {
    const res = await handleMintBurnEvents(emptyDb, baseUrl);
    expect(res.status).toBe(400);
  });

  it("handleDigestSnapshot → 400 (missing date param)", async () => {
    const res = await handleDigestSnapshot(emptyDb, baseUrl);
    expect(res.status).toBe(400);
  });

  // --- Cache-passthrough handlers: always 503 with empty DB ---

  it("handleStablecoins → 503", async () => {
    const res = await handleStablecoins(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleStablecoinCharts → 503", async () => {
    const res = await handleStablecoinCharts(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleUsdsStatus → 503", async () => {
    const res = await handleUsdsStatus(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleBluechipRatings → 503", async () => {
    const res = await handleBluechipRatings(emptyDb);
    expect(res.status).toBe(503);
  });

  it("handleYieldRankings → 503", async () => {
    const res = await handleYieldRankings(emptyDb);
    expect(res.status).toBe(503);
  });
});
