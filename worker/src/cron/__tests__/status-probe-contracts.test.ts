import { describe, expect, it } from "vitest";
import { API_PATHS } from "@shared/lib/api-endpoints";
import {
  evaluateStatusProbePayload,
  hasStatusProbePayloadContract,
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
    sync: { status: "ok" },
    ...overrides,
  };
}

describe("status probe payload contracts", () => {
  it("scopes the contract to the reserve and redemption probe paths", () => {
    expect(hasStatusProbePayloadContract(RESERVES_PATH)).toBe(true);
    expect(hasStatusProbePayloadContract(REDEMPTION_PATH)).toBe(true);
    expect(hasStatusProbePayloadContract("/api/health")).toBe(false);
    expect(hasStatusProbePayloadContract("/api/stablecoins")).toBe(false);
  });

  it("passes a live, clean reserve payload", () => {
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves())).toEqual({
      ok: true, semanticStatus: "healthy",
    });
  });

  it.each([
    ["curated-fallback", "reserve-mode-curated-fallback", "degraded"],
    ["template-fallback", "reserve-mode-template-fallback", "degraded"],
    ["unavailable", "reserve-mode-unavailable", "degraded"],
    ["live-stale", "reserve-mode-live-stale", "stale"],
  ] as const)("rejects reserve mode %s", (mode, error, semanticStatus) => {
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves({ mode })))
      .toEqual({ ok: false, error, semanticStatus });
  });

  it("rejects a live mode whose sync is degraded or whose slices are empty", () => {
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves({ sync: { status: "degraded" } })))
      .toEqual({ ok: false, error: "reserve-sync-degraded", semanticStatus: "degraded" });
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves({ sync: { status: "error" } })))
      .toEqual({ ok: false, error: "reserve-sync-error", semanticStatus: "degraded" });
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), liveReserves({ reserves: [] })))
      .toEqual({ ok: false, error: "reserve-slices-empty", semanticStatus: "stale" });
  });

  it("fails the payload's own stale freshness verdict", () => {
    expect(evaluateStatusProbePayload(
      RESERVES_PATH,
      new Headers({ Warning: '110 - "Response is stale (90000s old, fresh budget 3600s)"' }),
      liveReserves(),
    )).toEqual({ ok: false, error: "stale-freshness-header", semanticStatus: "stale" });
  });

  it("passes a redemption map whose rows all resolved", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), {
      coins: { "usdc-circle": { resolutionState: "resolved" } },
      updatedAt: 1_700_000_000,
    })).toEqual({ ok: true, semanticStatus: "healthy" });
  });

  it("rejects an empty redemption map or failed placeholder rows", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), { coins: {}, updatedAt: 1_700_000_000 }))
      .toEqual({ ok: false, error: "redemption-coins-empty", semanticStatus: "stale" });
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), {
      coins: {
        "usdc-circle": { resolutionState: "resolved" },
        "usdt-tether": { resolutionState: "failed" },
        "dai-maker": { resolutionState: "failed" },
      },
    })).toEqual({
      ok: false, error: "redemption-unresolved-placeholders:2", semanticStatus: "degraded",
    });
  });

  it("rejects a redemption generation past its consumer budget", () => {
    const payload = { coins: { "usdc-circle": { resolutionState: "resolved" } }, updatedAt: 1_700_000_000 };
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers({ "X-Data-Age": "28800" }), payload))
      .toEqual({ ok: true, semanticStatus: "healthy" });
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers({ "X-Data-Age": "28801" }), payload))
      .toEqual({ ok: false, error: "redemption-generation-stale:28801s", semanticStatus: "stale" });
  });

  it("never treats an unparseable payload as healthy", () => {
    expect(evaluateStatusProbePayload(REDEMPTION_PATH, new Headers(), null))
      .toEqual({ ok: false, error: "invalid-probe-payload", semanticStatus: "stale" });
    expect(evaluateStatusProbePayload(RESERVES_PATH, new Headers(), [])).toMatchObject({ ok: false });
  });
});
