import { describe, expect, it } from "vitest";
import { getNativeEventPrice, isNativePegEvent, PSI_NATIVE_EVIDENCE_MAX_AGE_SEC } from "../depeg-quote-domain";

describe("native event evidence", () => {
  it("honors historical quote provenance over the live-event inference", () => {
    expect(isNativePegEvent({ source: "backfill", peg_type: "peggedEUR", peg_reference: 1, quote_mode: "native-peg" })).toBe(true);
    expect(isNativePegEvent({ source: "live", peg_type: "peggedEUR", peg_reference: 1, quote_mode: "usd" })).toBe(false);
    expect(isNativePegEvent({ source: "live", peg_type: "peggedUSD", peg_reference: 1 })).toBe(false);
  });

  it("selects only timestamped, positive, as-of evidence inside its freshness budget", () => {
    const event = { peg_reference: 1, started_at: 100, start_price: 0.98, ended_at: 200, recovery_price: 1 };
    expect(getNativeEventPrice(event, 99)).toBeNull();
    expect(getNativeEventPrice(event, 199)).toBe(0.98);
    expect(getNativeEventPrice(event, 200)).toBe(1);
    expect(getNativeEventPrice(event, 200 + PSI_NATIVE_EVIDENCE_MAX_AGE_SEC - 1)).toBe(1);
    expect(getNativeEventPrice(event, 200 + PSI_NATIVE_EVIDENCE_MAX_AGE_SEC)).toBeNull();
    expect(getNativeEventPrice({ ...event, start_price: Number.NaN, recovery_price: 0 }, 200)).toBeNull();
  });

  it("selects the latest retained or current quote without borrowing a future or stale clock", () => {
    const event = { peg_reference: 1, started_at: 100, start_price: 0.98, ended_at: 200, recovery_price: 1 };
    const quote = { value: 0.97, observedAt: 150, source: "coingecko" as const };
    expect(getNativeEventPrice(event, 199, quote)).toBe(0.97);
    expect(getNativeEventPrice(event, 200, quote)).toBe(1);
    expect(getNativeEventPrice(event, 250, { ...quote, observedAt: 251 })).toBe(1);
    const asOf = 200 + PSI_NATIVE_EVIDENCE_MAX_AGE_SEC;
    expect(getNativeEventPrice(event, asOf, { ...quote, observedAt: asOf - 1 })).toBe(0.97);
    expect(getNativeEventPrice(event, asOf, { ...quote, observedAt: 200 })).toBeNull();
  });
});
