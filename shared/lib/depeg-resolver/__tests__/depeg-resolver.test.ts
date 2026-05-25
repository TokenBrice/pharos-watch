import { describe, expect, it } from "vitest";
import {
  computeDuration,
  depthBucket,
  groupIncidents,
  quarantinedCoins,
  resolveDepeg,
  resolveOutlook,
  structuralClass,
  type DdrActiveEventInput,
  type DdrCoinStructural,
  type DdrHistoricalEvent,
  type DdrIncident,
  type DdrLiveContext,
  type DdrStratumKey,
  type DdrSupplyContext,
} from "../index";

const baseSupply = (over: Partial<DdrSupplyContext> = {}): DdrSupplyContext => ({
  covered: true,
  change7dPct: 0,
  change30dPct: 0,
  mintSurge: false,
  ...over,
});
const baseLive = (over: Partial<DdrLiveContext> = {}): DdrLiveContext => ({ ...over });
const event = (over: Partial<DdrActiveEventInput> = {}): DdrActiveEventInput => ({
  id: 1,
  stablecoinId: "x",
  symbol: "X",
  pegType: "peggedUSD",
  direction: "below",
  peakDeviationBps: -300,
  startedAt: 1_000_000,
  pegReference: 1,
  ...over,
});
const coin = (over: Partial<DdrCoinStructural> = {}): DdrCoinStructural => ({
  id: "x",
  symbol: "X",
  name: "X",
  pegCurrency: "USD",
  governance: "decentralized",
  ...over,
});

describe("depthBucket", () => {
  it("matches spike thresholds", () => {
    expect(depthBucket(-100)).toBe("minor");
    expect(depthBucket(-250)).toBe("minor");
    expect(depthBucket(-900)).toBe("moderate");
    expect(depthBucket(-2000)).toBe("severe");
    expect(depthBucket(-9025)).toBe("catastrophic");
  });
});

describe("structuralClass", () => {
  it("treats immutable CDP as robust and concentrated/algorithmic as fragile", () => {
    expect(structuralClass(coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved" }))).toBe("robust");
    expect(structuralClass(coin({ mechanismArchetype: "algorithmic" }))).toBe("fragile");
    expect(structuralClass(coin({ authorityPosture: "unbounded-or-compromised" }))).toBe("fragile");
    expect(structuralClass(coin({ collateralQuality: "exotic", mechanismArchetype: "cdp" }))).toBe("fragile");
  });
});

describe("resolveOutlook — acceptance cases", () => {
  it("USR-like: concentrated/unbounded minter + supply spike + deep below → recovery_unlikely", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "usr-resolv", direction: "below", peakDeviationBps: -9025 }),
      coin({
        authorityPosture: "unbounded-or-compromised",
        mintPath: "offchain-attested-minter",
        governance: "centralized",
        custodyModel: "institutional-unregulated",
      }),
      baseSupply({ mintSurge: true, change7dPct: 40 }),
      baseLive({ liquidityScore: 15, tvlChange7d: -60 }),
    );
    expect(r.tier).toBe("recovery_unlikely");
    expect(r.factors.some((f) => f.code === "K1_supply_weaponization" && f.severity === "severe")).toBe(true);
  });

  it("LUSD-like: immutable, native collateral, no anomaly, decentralized → recovery_likely", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "lusd-liquity", direction: "below", peakDeviationBps: -300 }),
      coin({
        mechanismArchetype: "cdp",
        authorityPosture: "none-resolved",
        mintPath: "immutable-user-collateralized",
        governance: "decentralized",
        custodyModel: "onchain",
        canBeBlacklisted: false,
        collateralQuality: "native",
      }),
      baseSupply({ mintSurge: false, change7dPct: 1 }),
      baseLive({ safetyScore: 92, liquidityScore: 80 }),
    );
    expect(r.tier).toBe("recovery_likely");
  });

  it("USDC-SVB-like: severe below but strong fiat issuer, no supply anomaly → not recovery_unlikely", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "usdc-circle", direction: "below", peakDeviationBps: -2141 }),
      coin({
        mechanismArchetype: "fiat-cash",
        mintPath: "issuer-direct-mint",
        authorityPosture: "concentrated-admin",
        governance: "centralized",
        custodyModel: "institutional-regulated",
        canBeBlacklisted: true,
        collateralQuality: "rwa",
      }),
      baseSupply({ mintSurge: false, change7dPct: -2 }),
      baseLive({ safetyScore: 80, liquidityScore: 70, blacklistSurge: false }),
    );
    expect(r.tier).not.toBe("recovery_unlikely");
  });

  it("frozen issuer with an open event → recovery_unlikely", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -500 }),
      coin({ status: "frozen", mechanismArchetype: "cdp" }),
      baseSupply(),
      baseLive(),
    );
    expect(r.tier).toBe("recovery_unlikely");
  });

  it("overpeg is quasi-certain to recover, unless premium is sticky", () => {
    const recoverable = resolveOutlook(
      event({ direction: "above", peakDeviationBps: 300 }),
      coin({ mechanismArchetype: "cdp" }),
      baseSupply(),
      baseLive({ liquidityScore: 70 }),
    );
    expect(recoverable.tier).toBe("recovery_likely");

    const sticky = resolveOutlook(
      event({ direction: "above", peakDeviationBps: 300 }),
      coin({ mechanismArchetype: "cdp" }),
      baseSupply(),
      baseLive({ liquidityScore: 15, tvlChange7d: -60 }),
    );
    expect(sticky.tier).toBe("at_risk");
  });

  it("no structural read and no supply coverage → insufficient_signal", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: undefined, authorityPosture: undefined }),
      baseSupply({ covered: false, change7dPct: null, change30dPct: null, mintSurge: null }),
      baseLive(),
    );
    expect(r.tier).toBe("insufficient_signal");
    expect(r.insufficientReasons && r.insufficientReasons.length).toBeGreaterThan(0);
  });
});

describe("incident grouping + quarantine", () => {
  const usd = () => "USD";
  it("merges fragments within 6h and splits beyond", () => {
    const events: DdrHistoricalEvent[] = [
      { stablecoinId: "a", direction: "below", peakDeviationBps: -300, startedAt: 0, endedAt: 3600, recoveryPrice: 1 },
      { stablecoinId: "a", direction: "below", peakDeviationBps: -500, startedAt: 3600 + 60, endedAt: 7200, recoveryPrice: 1 },
      { stablecoinId: "a", direction: "below", peakDeviationBps: -200, startedAt: 7200 + 100 * 3600, endedAt: 7200 + 101 * 3600, recoveryPrice: 1 },
    ];
    const incidents = groupIncidents(events, usd);
    expect(incidents.length).toBe(2);
    const merged = incidents.find((i) => i.startedAt === 0)!;
    expect(Math.abs(merged.peakDeviationBps)).toBe(500); // worst across merged fragments
    expect(merged.recovered).toBe(true);
  });

  it("flags high-frequency sub-30min coins for quarantine", () => {
    const flapper: DdrIncident[] = Array.from({ length: 60 }, (_, i) => ({
      stablecoinId: "flapper",
      direction: "below" as const,
      peakDeviationBps: -120,
      depth: "minor" as const,
      currency: "USD" as const,
      structural: "fragile" as const,
      startedAt: i * 10000,
      endedAt: i * 10000 + 600,
      durationSec: 600,
      recovered: true,
    }));
    const calm: DdrIncident[] = Array.from({ length: 5 }, (_, i) => ({
      stablecoinId: "calm",
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: i * 10000,
      endedAt: i * 10000 + 50000,
      durationSec: 50000,
      recovered: true,
    }));
    const q = quarantinedCoins([...flapper, ...calm]);
    expect(q.has("flapper")).toBe(true);
    expect(q.has("calm")).toBe(false);
  });
});

describe("computeDuration", () => {
  const makeStratum = (n: number, durationSec: number, coinPrefix: string): DdrIncident[] =>
    Array.from({ length: n }, (_, i) => ({
      stablecoinId: `${coinPrefix}-${i % 12}`,
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: i * 100000,
      endedAt: i * 100000 + durationSec,
      durationSec,
      recovered: true,
    }));

  const key: DdrStratumKey = { direction: "below", depth: "moderate", structural: "robust", currency: "USD" };

  it("returns a supported median + monotonic horizon probabilities with enough data", () => {
    // 40 incidents across 12 coins, total duration ~24h
    const incidents = makeStratum(40, 24 * 3600, "c");
    const d = computeDuration(key, 0, incidents, new Set());
    expect(d.suppressed).toBe(false);
    expect(d.medianSec).toBeGreaterThan(0);
    const p6 = d.horizons.find((h) => h.horizon === "6h")!;
    const p7d = d.horizons.find((h) => h.horizon === "7d")!;
    // by 7d everything (all 24h incidents) has resolved; by 6h none have
    expect(p7d.intervalClosures).toBeGreaterThanOrEqual(p6.intervalClosures);
  });

  it("suppresses the band when support is too thin", () => {
    const incidents = makeStratum(4, 24 * 3600, "c");
    const d = computeDuration(key, 0, incidents, new Set());
    expect(d.suppressed).toBe(true);
    expect(d.suppressedReason).toBe("insufficient_support");
    expect(d.medianSec).toBeNull();
  });
});

describe("resolveDepeg orchestration", () => {
  it("suppresses duration for a terminal verdict", () => {
    const row = resolveDepeg({
      active: event({ stablecoinId: "usr-resolv", direction: "below", peakDeviationBps: -9025 }),
      coin: coin({ authorityPosture: "unbounded-or-compromised", mintPath: "offchain-attested-minter", governance: "centralized" }),
      supply: baseSupply({ mintSurge: true, change7dPct: 40 }),
      live: baseLive({ liquidityScore: 15, tvlChange7d: -60 }),
      nowSec: 1_000_000 + 3600,
      incidents: [],
      quarantined: new Set(),
    });
    expect(row.resolution.tier).toBe("recovery_unlikely");
    expect(row.duration.suppressed).toBe(true);
    expect(row.duration.suppressedReason).toBe("verdict_terminal");
    expect(row.ageSec).toBe(3600);
  });
});
