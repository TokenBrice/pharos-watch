import { afterEach, describe, expect, it, vi } from "vitest";
import { mockFetch } from "@shared/test-utils/mock-fetch";
import { fetchCip56RegistrySupply, type Cip56RegistryInstrumentSource } from "../cip56-registry";
import cip56Fixture from "./fixtures/cip56-usd1-instrument-2026-10-30.json";

const SOURCE: Cip56RegistryInstrumentSource = {
  url: "https://api.utilities.digitalasset.com/api/token-standard/v0/registrars/1220b::1220bab043849b986b52bc6271edf1ae962bab03d9f0c0713f071732d2278386bd02/registry/metadata/v1/instruments/USD1",
  registrarParty: "1220b::1220bab043849b986b52bc6271edf1ae962bab03d9f0c0713f071732d2278386bd02",
  instrumentId: "USD1",
  symbol: "USD1",
  decimals: 10,
  maxSupplyAgeSec: 7 * 24 * 60 * 60,
};

const OBSERVED_AT = 1_793_370_127;
const IN_BOUND_NOW = OBSERVED_AT + 3_600;
const signal = new AbortController().signal;

function install(payload: unknown): void {
  mockFetch([{ match: SOURCE.url, body: payload }]);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchCip56RegistrySupply", () => {
  it("scales the registry-reported totalSupply and carries its last-computed clock", async () => {
    install(cip56Fixture);

    const read = await fetchCip56RegistrySupply(SOURCE, { signal, nowSec: IN_BOUND_NOW });

    expect(read).toEqual({
      raw: 1_239_859_800_019n,
      decimals: 10,
      observedAt: OBSERVED_AT,
      asOf: "2026-10-30T14:22:07.742Z",
    });
  });

  it("fails closed when the registry clock is older than the reviewed supply-age bound", async () => {
    install(cip56Fixture);

    await expect(fetchCip56RegistrySupply(SOURCE, {
      signal,
      nowSec: OBSERVED_AT + SOURCE.maxSupplyAgeSec + 1,
    })).rejects.toThrow(/totalSupplyAsOf.*old/);
  });

  it("fails closed on a future registry clock beyond tolerated skew", async () => {
    install(cip56Fixture);

    await expect(fetchCip56RegistrySupply(SOURCE, {
      signal,
      nowSec: OBSERVED_AT - 301,
    })).rejects.toThrow(/future/);
  });

  it.each([
    ["missing totalSupply", { ...cip56Fixture, totalSupply: undefined }],
    ["missing totalSupplyAsOf", { ...cip56Fixture, totalSupplyAsOf: undefined }],
    ["optional-null totalSupply", { ...cip56Fixture, totalSupply: null }],
    ["instrument id drift", { ...cip56Fixture, id: "USD2" }],
    ["symbol drift", { ...cip56Fixture, symbol: "USD2" }],
    ["decimals drift", { ...cip56Fixture, decimals: 6 }],
    ["out-of-range decimals", { ...cip56Fixture, decimals: 11 }],
    ["negative supply", { ...cip56Fixture, totalSupply: "-1" }],
    ["non-decimal supply", { ...cip56Fixture, totalSupply: "1,234.5" }],
  ])("rejects %s instead of inventing a value", async (_label, payload) => {
    install(payload);

    await expect(fetchCip56RegistrySupply(SOURCE, { signal, nowSec: IN_BOUND_NOW })).rejects.toThrow();
  });

  it("accepts an observed zero as a valid empty deployment", async () => {
    install({ ...cip56Fixture, totalSupply: "0" });

    const read = await fetchCip56RegistrySupply(SOURCE, { signal, nowSec: IN_BOUND_NOW });

    expect(read.raw).toBe(0n);
  });

  it("surfaces an HTTP failure without parsing a body", async () => {
    mockFetch([{ match: SOURCE.url, body: { error: "unavailable" }, status: 500 }]);

    await expect(fetchCip56RegistrySupply(SOURCE, { signal, nowSec: IN_BOUND_NOW }))
      .rejects.toThrow(/HTTP 500/);
  });

  it("rejects a non-JSON body", async () => {
    mockFetch([{ match: SOURCE.url, body: "not json" }]);

    await expect(fetchCip56RegistrySupply(SOURCE, { signal, nowSec: IN_BOUND_NOW }))
      .rejects.toThrow(/JSON parse failed/);
  });
});
