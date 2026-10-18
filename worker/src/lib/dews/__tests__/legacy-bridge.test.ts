import { describe, expect, it } from "vitest";
import { decodeLegacyStressSignals } from "../source-state/legacy-bridge";

const COMPUTED_AT = 1_700_000_000;

describe("decodeLegacyStressSignals", () => {
  it("passes a pre-envelope flat signals map through unchanged", () => {
    const legacy = {
      supply: { value: 5, available: true },
      pool: { value: 12, delta1d: -0.04 },
    };

    expect(decodeLegacyStressSignals(JSON.stringify(legacy), COMPUTED_AT)).toEqual({
      ok: true,
      payload: legacy,
    });
  });

  it("unwraps the envelope signals and never treats envelope metadata as a signal", () => {
    const wrapped = {
      signals: { supply: { value: 8, available: false } },
      amplifiers: { psi: 1.2, contagion: 1.1 },
      baseScore: 30,
      finalScore: 42,
      evidenceKinds: ["market-price"],
    };

    expect(decodeLegacyStressSignals(JSON.stringify(wrapped), COMPUTED_AT)).toEqual({
      ok: true,
      payload: { supply: { value: 8, available: false } },
    });
  });

  it("reports a missing blob distinctly from a failed parse", () => {
    expect(decodeLegacyStressSignals(null, COMPUTED_AT)).toEqual({ ok: false, reason: "missing" });
    expect(decodeLegacyStressSignals("", COMPUTED_AT)).toEqual({ ok: false, reason: "json-parse-failed" });
    expect(decodeLegacyStressSignals("{not-json", COMPUTED_AT)).toEqual({ ok: false, reason: "json-parse-failed" });
  });

  it.each(["[]", "\"signals\"", "3", "null"])("rejects the non-record root %s as an invalid shape", (payload) => {
    expect(decodeLegacyStressSignals(payload, COMPUTED_AT)).toEqual({ ok: false, reason: "invalid-shape" });
  });

  it("drops malformed signal entries while keeping readable siblings", () => {
    const payload = {
      supply: { value: 5, available: true },
      pool: "unavailable",
      liq: { value: "9" },
      flow: { value: 3, burnSurge: 1.4, warnings: ["partial-coverage"] },
    };

    expect(decodeLegacyStressSignals(JSON.stringify(payload), COMPUTED_AT)).toEqual({
      ok: true,
      payload: {
        supply: { value: 5, available: true },
        flow: { value: 3, burnSurge: 1.4, warnings: ["partial-coverage"] },
      },
    });
  });

  it("drops a non-finite value read from JSON instead of hydrating it", () => {
    expect(decodeLegacyStressSignals('{"supply":{"value":1e400},"pool":{"value":4}}', COMPUTED_AT)).toEqual({
      ok: true,
      payload: { pool: { value: 4 } },
    });
  });

  it("falls back to the flat interpretation when the envelope signals member is not an object", () => {
    expect(decodeLegacyStressSignals(JSON.stringify({ signals: 3 }), COMPUTED_AT)).toEqual({ ok: true, payload: {} });
  });
});
