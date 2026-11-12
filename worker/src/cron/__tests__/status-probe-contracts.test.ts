import { describe, expect, it } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  evaluateStatusProbePayload,
  hasStatusProbePayloadContract,
  isStatusLevelOnlyProbePath,
} from "../status-probe-contracts";

const RESERVES_PATH = API_PATHS.stablecoinReserves("iusd-infinifi");
const REDEMPTION_PATH = API_PATHS.redemptionBackstops();

function liveReserves(overrides: Record<string, unknown> = {}) {
  return {
    stablecoinId: "iusd-infinifi",
    mode: "live",
    reserves: [{ name: "T-bills", pct: 100, risk: "low" }],
    estimated: false,
    liveAt: 1_700_000_000,
    sync: { enabled: true, status: "ok", stale: false, bootstrap: false },
    ...overrides,
  };
}

describe("status probe payload contracts", () => {
  it("scopes reserve and redemption contracts", () => {
    expect(hasStatusProbePayloadContract(RESERVES_PATH)).toBe(true);
    expect(hasStatusProbePayloadContract(REDEMPTION_PATH)).toBe(true);
    expect(hasStatusProbePayloadContract("/api/health")).toBe(false);
    expect(hasStatusProbePayloadContract("/api/stablecoins")).toBe(false);
  });

  it.each([
    RESERVES_PATH,
    API_PATHS.reserveAttemptHistory({ coin: "usdc-circle", limit: 10 }),
    API_PATHS.redemptionBackstops(),
    API_PATHS.redemptionBackstopCoin("usdc-circle"),
    "/api/reserve-attempt-history?coin=usdc-circle&limit=10",
  ])("keeps %s status-level only", (path) => {
    expect(isStatusLevelOnlyProbePath(path)).toBe(true);
  });

  it.each(["/api/health", "/api/stablecoins", "/api/stablecoin-live-summary/usdc-circle", "/api/mint-burn-flows"])(
    "does not suppress %s", (path) => {
      expect(isStatusLevelOnlyProbePath(path)).toBe(false);
    },
  );

  it("passes a live, clean reserve payload", () => {
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves())).toEqual({ ok: true });
  });

  it.each(["live", "live-stale", "curated-fallback", "template-fallback", "unavailable"])(
    "passes valid %s reserves despite asset quality", mode => {
      for (const status of ["degraded", "error"]) {
        const payload = liveReserves({ mode, liveAt: mode.startsWith("live") ? 1_700_000_000 : undefined,
          estimated: mode === "template-fallback", ...(mode === "unavailable" ? { reserves: [] } : {}),
          sync: { enabled: true, status, stale: mode === "live-stale", bootstrap: false } });
        expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(status === "error" ? { Warning: '110 - "stale"' } : {}), payload))
          .toEqual({ ok: true });
      }
    },
  );

  it.each([
    { reserves: [] }, { reserves: [{ name: "Cash", pct: "100", risk: "low" }] },
    { stablecoinId: "other" }, { mode: "unknown" }, { estimated: true }, { liveAt: undefined },
    { mode: "unavailable" }, { sync: { status: "ok" } },
  ])("rejects malformed or inconsistent reserves %j", overrides => {
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves(overrides)).ok).toBe(false);
  });

  it("fails the payload's own stale freshness verdict", () => {
    expect(evaluateStatusProbePayload(
      REDEMPTION_PATH,
      new Headers({ Warning: '110 - "Response is stale (90000s old, fresh budget 3600s)"' }),
      liveReserves(),
    )).toEqual({ ok: false, error: "stale-freshness-header" });
  });

  it("fails a future-dated generation the producer marked 199 and no-store", () => {
    expect(evaluateStatusProbePayload(
      REDEMPTION_PATH,
      new Headers({
        Warning: '199 - "Response timestamp is 3600s in the future"',
        "Cache-Control": "no-store",
        "X-Data-Age": "0",
      }),
      { coins: { "usdc-circle": { resolutionState: "resolved" } }, updatedAt: 1_700_000_000 },
    )).toEqual({ ok: false, error: "generation-timestamp-in-future" });
  });

  it("passes a redemption map whose rows all resolved", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), {
      coins: { "usdc-circle": { resolutionState: "resolved" } },
      updatedAt: 1_700_000_000,
    })).toEqual({ ok: true });
  });

  it("rejects an empty redemption map or failed placeholder rows", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), { coins: {}, updatedAt: 1_700_000_000 }))
      .toEqual({ ok: false, error: "redemption-coins-empty" });
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), {
      coins: {
        "usdc-circle": { resolutionState: "resolved" },
        "usdt-tether": { resolutionState: "failed" },
        "dai-maker": { resolutionState: "failed" },
      },
    })).toEqual({ ok: false, error: "redemption-unresolved-placeholders:2" });
  });

  it("rejects a redemption generation past its consumer budget", () => {
    const payload = { coins: { "usdc-circle": { resolutionState: "resolved" } }, updatedAt: 1_700_000_000 };
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers({ "X-Data-Age": "28800" }), payload))
      .toEqual({ ok: true });
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers({ "X-Data-Age": "28801" }), payload))
      .toEqual({ ok: false, error: "redemption-generation-stale:28801s" });
  });

  it("never treats an unparseable payload as healthy", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), null))
      .toEqual({ ok: false, error: "invalid-probe-payload" });
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), [])).toMatchObject({ ok: false });
  });
});
