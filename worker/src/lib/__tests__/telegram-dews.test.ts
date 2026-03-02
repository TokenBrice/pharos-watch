import { describe, it, expect } from "vitest";
import { buildDewsAlertMessage, extractTopSignals } from "../telegram";
import type { DewsAlertParams } from "../telegram";

const BASE_PARAMS: DewsAlertParams = {
  stablecoinId: "5",
  name: "USD Coin",
  symbol: "USDC",
  backing: "rwa-backed",
  governance: "centralized",
  mcapUsd: 43_200_000_000,
  price: 0.9987,
  score: 62,
  band: "WARNING",
  prevBand: "ALERT",
  topSignals: [
    { label: "Pool Balance Drift", value: 68 },
    { label: "Liquidity Erosion", value: 54 },
    { label: "Supply Velocity", value: 42 },
  ],
};

describe("buildDewsAlertMessage", () => {
  it("uses warning emoji for WARNING band", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("⚠️");
    expect(msg).not.toContain("🚨");
  });

  it("uses danger emoji for DANGER band", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, band: "DANGER", score: 82, prevBand: "WARNING" });
    expect(msg).toContain("🚨");
    expect(msg).not.toContain("⚠️");
  });

  it("includes coin symbol and band in header", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("<b>WARNING: USDC</b>");
  });

  it("includes score and previous band", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("62");
    expect(msg).toContain("up from ALERT");
  });

  it("formats mcap in billions", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("$43.2B");
  });

  it("formats small mcap in millions", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, mcapUsd: 750_000_000 });
    expect(msg).toContain("$750M");
  });

  it("includes price when provided", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("$0.9987");
  });

  it("omits price line when price is null", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, price: null });
    expect(msg).not.toContain("Price:");
  });

  it("lists top signals", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("Pool Balance Drift: 68");
    expect(msg).toContain("Liquidity Erosion: 54");
    expect(msg).toContain("Supply Velocity: 42");
  });

  it("omits signal section when no elevated signals", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, topSignals: [] });
    expect(msg).not.toContain("Top stress signals");
  });

  it("includes pharos link with correct stablecoin id", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS);
    expect(msg).toContain("https://pharos.watch/stablecoin/5");
  });

  it("escapes HTML in coin name", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, name: "Coin <Test> & More" });
    expect(msg).toContain("Coin &lt;Test&gt; &amp; More");
    expect(msg).not.toContain("<Test>");
  });

  it("formats backing as display label", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS); // backing: "rwa-backed"
    expect(msg).toContain("RWA-Backed");
    expect(msg).not.toContain("rwa-backed");
  });

  it("formats governance as display label", () => {
    const msg = buildDewsAlertMessage(BASE_PARAMS); // governance: "centralized"
    expect(msg).toContain("Centralized");
  });

  it("formats centralized-dependent governance", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, governance: "centralized-dependent" });
    expect(msg).toContain("CeFi-Dependent");
  });

  it("formats decentralized governance as display label", () => {
    const msg = buildDewsAlertMessage({ ...BASE_PARAMS, governance: "decentralized" });
    expect(msg).toContain("Decentralized");
  });
});

describe("extractTopSignals", () => {
  const signals = {
    supply: { value: 42, available: true },
    pool: { value: 68, available: true },
    liq: { value: 54, available: true },
    price: { value: 10, available: true },    // below threshold
    diverg: { value: 35, available: false },  // unavailable
    black: { value: 0, available: true },
  };

  it("returns available signals above threshold, sorted descending", () => {
    const result = extractTopSignals(signals);
    expect(result).toEqual([
      { label: "Pool Balance Drift", value: 68 },
      { label: "Liquidity Erosion", value: 54 },
      { label: "Supply Velocity", value: 42 },
    ]);
  });

  it("excludes unavailable signals", () => {
    const result = extractTopSignals(signals);
    const labels = result.map(s => s.label);
    expect(labels).not.toContain("Cross-source Divergence");
  });

  it("excludes signals below threshold", () => {
    const result = extractTopSignals(signals);
    const labels = result.map(s => s.label);
    expect(labels).not.toContain("Price Confidence");
    expect(labels).not.toContain("Blacklist Activity");
  });

  it("respects maxCount", () => {
    const result = extractTopSignals(signals, 2);
    expect(result).toHaveLength(2);
    expect(result[0].label).toBe("Pool Balance Drift");
    expect(result[1].label).toBe("Liquidity Erosion");
  });

  it("uses human-readable labels", () => {
    const result = extractTopSignals({ supply: { value: 50, available: true } });
    expect(result[0].label).toBe("Supply Velocity");
  });

  it("returns empty array when no signals meet criteria", () => {
    const result = extractTopSignals({ price: { value: 5, available: true } });
    expect(result).toEqual([]);
  });
});
