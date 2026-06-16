import { describe, expect, it } from "vitest";
import {
  computeDuration,
  candidateStrata,
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
  currentDeviationBps: -300,
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
      baseLive({ safetyScore: 92, liquidityScore: 80, redemptionCapacityRatio: 0.2, redemptionRouteFamily: "collateral-redeem" }),
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

  it("non-frozen terminal status (dead) is treated as terminal → recovery_unlikely", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -500 }),
      coin({ status: "dead", mechanismArchetype: "cdp" }),
      baseSupply(),
      baseLive(),
    );
    expect(r.tier).toBe("recovery_unlikely");
  });

  it("terminal coin in an overpeg break stays recovery_unlikely (no contradictory verdict)", () => {
    const r = resolveOutlook(
      event({ direction: "above", peakDeviationBps: 300 }),
      coin({ status: "frozen", mechanismArchetype: "cdp", authorityPosture: "none-resolved" }),
      baseSupply(),
      baseLive({ liquidityScore: 70 }),
    );
    expect(r.tier).toBe("recovery_unlikely");
    // The severe freeze/seizure kill must accompany the terminal verdict.
    expect(r.factors.some((f) => f.code === "K3_freeze_seizure" && f.severity === "severe")).toBe(true);
  });

  it("overpeg is quasi-certain to recover, unless premium is sticky", () => {
    const recoverable = resolveOutlook(
      event({ direction: "above", peakDeviationBps: 300 }),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved" }),
      baseSupply(),
      baseLive({ liquidityScore: 70 }),
    );
    expect(recoverable.tier).toBe("recovery_likely");

    const sticky = resolveOutlook(
      event({ direction: "above", peakDeviationBps: 300 }),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved" }),
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

  it("each missing key input independently yields insufficient_signal", () => {
    const structural = coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved" });
    expect(resolveOutlook(event(), coin({ mechanismArchetype: "cdp", authorityPosture: undefined }), baseSupply(), baseLive()).tier).toBe("insufficient_signal");
    expect(resolveOutlook(event(), structural, baseSupply({ covered: false, change7dPct: null, change30dPct: null, mintSurge: null }), baseLive()).tier).toBe("insufficient_signal");
    expect(resolveOutlook(event({ currentDeviationBps: null }), structural, baseSupply(), baseLive()).tier).toBe("insufficient_signal");
  });

  it("does not treat algorithmic mechanism alone as a reflexive death spiral", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -300 }),
      coin({ mechanismArchetype: "algorithmic", authorityPosture: "none-resolved" }),
      baseSupply({ mintSurge: false, change7dPct: 0 }),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "K4_reflexive_spiral")).toBe(false);
  });

  it("treats inherited blacklistability as freeze/seizure pressure during a surge", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "fiat-cash", authorityPosture: "concentrated-admin", canBeBlacklisted: "inherited" }),
      baseSupply(),
      baseLive({ blacklistSurge: true }),
    );
    expect(r.factors.some((f) => f.code === "K3_freeze_seizure" && f.severity === "severe")).toBe(true);
  });
});

describe("resolveOutlook — factor-code emission (guards against silent code renames)", () => {
  it("emits K2 severe for a frozen/dead collateral dependency", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", dependencyImpaired: true }),
      baseSupply(),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "severe")).toBe(true);
  });

  it("emits K2 elevated for an exotic collateral base", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", collateralQuality: "exotic", dependencyImpaired: false }),
      baseSupply(),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "elevated")).toBe(true);
  });

  it("emits R1 strong for immutable user-collateralized supply", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", mintPath: "immutable-user-collateralized" }),
      baseSupply(),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "R1_noninflatable_supply" && f.severity === "strong")).toBe(true);
  });

  it("emits R1 weak for governance-bounded user-collateralized supply", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "concentrated-admin", mintPath: "user-collateralized-governed" }),
      baseSupply(),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "R1_noninflatable_supply" && f.severity === "weak")).toBe(true);
  });

  it("emits R2 strong for hard collateral with a live redemption route", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", collateralQuality: "native" }),
      baseSupply(),
      baseLive({ redemptionCapacityRatio: 0.2, redemptionRouteFamily: "collateral-redeem" }),
    );
    expect(r.factors.some((f) => f.code === "R2_hard_collateral_redemption" && f.severity === "strong")).toBe(true);
  });

  it("emits R2 weak for an overcollateralized CDP without a live redemption route", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved" }),
      baseSupply(),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "R2_hard_collateral_redemption" && f.severity === "weak")).toBe(true);
  });

  it("emits K4 severe when an algorithmic mechanism expands supply into a deep below-peg break", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -2500 }),
      coin({ mechanismArchetype: "algorithmic", authorityPosture: "none-resolved" }),
      baseSupply({ mintSurge: true, change7dPct: 40 }),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "K4_reflexive_spiral" && f.severity === "severe")).toBe(true);
  });

  it("lets a strong structural anchor block recovery_unlikely at two elevated kills", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -300 }),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", collateralQuality: "native", custodyModel: "cex" }),
      baseSupply(),
      baseLive({ liquidityScore: 25, redemptionCapacityRatio: 0.2, redemptionRouteFamily: "collateral-redeem" }),
    );
    const elevatedKills = r.factors.filter((f) => f.kind === "kill" && f.severity === "elevated");
    expect(elevatedKills.length).toBe(2);
    expect(r.factors.some((f) => f.kind === "kill" && f.severity === "severe")).toBe(false);
    expect(r.factors.some((f) => f.code === "R2_hard_collateral_redemption" && f.severity === "strong")).toBe(true);
    expect(r.tier).not.toBe("recovery_unlikely");
    expect(r.tier).toBe("at_risk");
  });
});

describe("incident grouping + quarantine", () => {
  const usd = () => "USD";
  const incidentForQuarantine = (stablecoinId: string, durationSec: number, i: number): DdrIncident => ({
    stablecoinId,
    direction: "below",
    peakDeviationBps: -120,
    depth: "minor",
    currency: "USD",
    structural: "fragile",
    startedAt: i * 10000,
    endedAt: i * 10000 + durationSec,
    durationSec,
    recovered: true,
  });

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

  it("keeps the average-of-middle quarantine median boundary stable", () => {
    const borderline = [
      ...Array.from({ length: 26 }, (_, i) => incidentForQuarantine("borderline", 1799, i)),
      ...Array.from({ length: 26 }, (_, i) => incidentForQuarantine("borderline", 1801, i + 26)),
    ];
    const justBelow = [
      ...Array.from({ length: 26 }, (_, i) => incidentForQuarantine("just-below", 1798, i)),
      ...Array.from({ length: 26 }, (_, i) => incidentForQuarantine("just-below", 1800, i + 26)),
    ];

    const q = quarantinedCoins([...borderline, ...justBelow]);

    expect(q.has("borderline")).toBe(false);
    expect(q.has("just-below")).toBe(true);
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

  it("emits candidate strata in most-dependable-first order", () => {
    expect(candidateStrata({ ...key, depth: "severe" })).toEqual([
      { direction: "below", depths: ["severe"], structural: "robust", currency: "USD" },
      { direction: "below", depths: ["severe"], structural: "robust", currency: "__any__" },
      { direction: "below", depths: ["severe", "catastrophic"], structural: "robust", currency: "__any__" },
      { direction: "below", depths: ["moderate", "severe", "catastrophic"], structural: "robust", currency: "__any__" },
      { direction: "below", depths: ["severe"], structural: "__any__", currency: "__any__" },
      { direction: "below", depths: ["severe", "catastrophic"], structural: "__any__", currency: "__any__" },
      { direction: "below", depths: ["moderate", "severe", "catastrophic"], structural: "__any__", currency: "__any__" },
    ]);
  });

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

  it("uses remaining duration at the landmark age", () => {
    const incidents = makeStratum(40, 24 * 3600, "c");
    const d = computeDuration(key, 6 * 3600, incidents, new Set());
    expect(d.suppressed).toBe(false);
    expect(d.medianSec).toBe(18 * 3600);
  });

  it("does not borrow minor-depth clocks for a severe active event", () => {
    const minorIncidents: DdrIncident[] = Array.from({ length: 40 }, (_, i) => ({
      stablecoinId: `m-${i % 12}`,
      direction: "below" as const,
      peakDeviationBps: -120,
      depth: "minor" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: i * 100000,
      endedAt: i * 100000 + 3600,
      durationSec: 3600,
      recovered: true,
    }));
    const d = computeDuration({ ...key, depth: "severe" }, 0, minorIncidents, new Set());
    expect(d.suppressed).toBe(true);
    expect(d.stratum).toContain("severe");
  });

  it("matches historical depth as observed at landmark age, not final peak", () => {
    const incidents: DdrIncident[] = Array.from({ length: 12 }, (_, i) => ({
      stablecoinId: `coin-${i}`,
      direction: "below" as const,
      peakDeviationBps: -2000,
      depth: "severe" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: i * 100000,
      endedAt: i * 100000 + 12 * 3600,
      durationSec: 12 * 3600,
      recovered: true,
      fragments: [
        { offsetSec: 0, peakDeviationBps: -500 },
        { offsetSec: 8 * 3600, peakDeviationBps: -2000 },
      ],
    }));
    const d = computeDuration({ ...key, depth: "severe" }, 2 * 3600, incidents, new Set());
    expect(d.stratum).not.toBe("below · severe · robust · USD");
    expect(d.stratum).toContain("moderate+severe+catastrophic");
  });

  it("selects the structural-preserving broad stratum before dropping structure", () => {
    const incidents: DdrIncident[] = Array.from({ length: 12 }, (_, i) => ({
      stablecoinId: `broad-${i}`,
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: i % 2 === 0 ? "USD" as const : "non-USD" as const,
      structural: "robust" as const,
      startedAt: i * 100000,
      endedAt: i * 100000 + 14 * 3600,
      durationSec: 14 * 3600,
      recovered: true,
    }));

    const d = computeDuration({ ...key, depth: "severe" }, 0, incidents, new Set());

    expect(d.suppressed).toBe(false);
    expect(d.stratum).toBe("below · moderate+severe+catastrophic · robust · any");
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
      incidents: Array.from({ length: 20 }, (_, i) => ({
        stablecoinId: `c-${i}`,
        direction: "below" as const,
        peakDeviationBps: -500,
        depth: "moderate" as const,
        currency: "USD" as const,
        structural: "fragile" as const,
        startedAt: i * 100000,
        endedAt: i * 100000 + 24 * 3600,
        durationSec: 24 * 3600,
        recovered: true,
      })),
      quarantined: new Set(),
    });
    expect(row.resolution.tier).toBe("recovery_unlikely");
    expect(row.duration.suppressed).toBe(true);
    expect(row.duration.suppressedReason).toBe("verdict_terminal");
    expect(row.duration.horizons).toEqual([]);
    expect(row.ageSec).toBe(3600);
  });
});
