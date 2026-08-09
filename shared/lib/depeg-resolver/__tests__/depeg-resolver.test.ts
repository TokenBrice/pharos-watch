import { describe, expect, it } from "vitest";
import {
  buildDurationTrainingCorpus,
  computeDuration,
  candidateStrata,
  depthBucket,
  DURATION_LABEL_MERGE_GAP_SEC,
  groupDurationLabelIncidents,
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
  type DdrV9ExitContext,
  type DdrWindDownFingerprintContext,
} from "../index";

const baseSupply = (over: Partial<DdrSupplyContext> = {}): DdrSupplyContext => ({
  covered: true,
  change7dPct: 0,
  change30dPct: 0,
  mintSurge: false,
  ...over,
});
const baseLive = (
  over: Partial<DdrLiveContext & DdrWindDownFingerprintContext> = {},
): DdrLiveContext & DdrWindDownFingerprintContext => ({ ...over });
const v9Exit = (over: Partial<DdrV9ExitContext> = {}): DdrV9ExitContext => ({
  pillarScore: 80,
  reasonCodes: [],
  stressRequest: { requestedNotionalUsd: 1_000_000 },
  primaryRoute: {
    key: "redemption:measured",
    score: 80,
    capacity: {
      executableUsd: 500_000,
      requestedNotionalUsd: 1_000_000,
      completionRatio: 0.5,
    },
  },
  ...over,
});
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

  it("keeps a reconciled unbounded minter fragile, including over a robust archetype", () => {
    // The curated vocabulary gained `unbounded-reconciled` as a refinement of
    // the unbounded class. Re-annotating a supervised issuer from
    // `unbounded-or-compromised` to it must not reclassify the coin, or ~110
    // assets would silently change stratum and move DDR duration percentiles.
    expect(structuralClass(coin({ authorityPosture: "unbounded-reconciled" }))).toBe("fragile");
    expect(
      structuralClass(coin({ mechanismArchetype: "fiat-cash", authorityPosture: "unbounded-reconciled" })),
    ).toBe(structuralClass(coin({ mechanismArchetype: "fiat-cash", authorityPosture: "unbounded-or-compromised" })));
  });

  it("reads none-resolved-mint as benign but not as structurally robust", () => {
    // The mint-scoped value states only that *this* asset has no minter. It is
    // therefore not a fragile posture — it must not by itself force fragile the
    // way the unbounded/concentrated rungs do.
    expect(structuralClass(coin({ mechanismArchetype: "fiat-cash", authorityPosture: "none-resolved-mint" }))).toBe(
      "robust",
    );
    // But it is not whole-of-chain `none-resolved` either: with no robust
    // archetype and no immutable mint path it carries no robustness of its own,
    // because the wrapper's parent can still print.
    expect(structuralClass(coin({ authorityPosture: "none-resolved-mint" }))).toBe("fragile");
    expect(structuralClass(coin({ authorityPosture: "none-resolved" }))).toBe("robust");
  });
});

describe("DDR curated-posture set membership — pinned", () => {
  // Set membership now lives in the shared `safety-score-v9/mint-posture`
  // predicates (`isFragileMintPosture`, `isUnboundedMintPosture`,
  // `isNoPrivilegedMintPosture`, `isNoPrivilegedMintChainPosture`) rather than
  // in per-engine literal sets. Membership is still pinned here through the
  // behaviour each predicate drives, so a vocabulary addition that lands in the
  // wrong set fails loudly at the DDR boundary rather than silently.
  const surging = () => baseSupply({ mintSurge: true, change7dPct: 40 });
  const deepBelow = () => event({ direction: "below", peakDeviationBps: -2000 });
  const k1 = (posture: string) =>
    resolveOutlook(
      deepBelow(),
      coin({ authorityPosture: posture as DdrCoinStructural["authorityPosture"] }),
      surging(),
      baseLive(),
    ).factors.find((factor) => factor.code === "K1_supply_weaponization") ?? null;

  it("keeps unbounded-reconciled fragile, risky, and severe-surge eligible", () => {
    expect(structuralClass(coin({ authorityPosture: "unbounded-reconciled" }))).toBe("fragile");
    expect(k1("unbounded-reconciled")).toMatchObject({ severity: "severe" });
  });

  it("keeps concentrated-admin fragile and risky but never severe on surge alone", () => {
    expect(structuralClass(coin({ authorityPosture: "concentrated-admin" }))).toBe("fragile");
    expect(k1("concentrated-admin")).toMatchObject({ severity: "elevated" });
  });

  it("keeps none-resolved-mint out of every adverse set", () => {
    // Not fragile, not risky, not severe-surge: a benign posture. The asset can
    // still reach K1 through its mintPath or published mint band — this pins
    // only that the *posture* contributes nothing adverse.
    expect(structuralClass(coin({ mechanismArchetype: "fiat-cash", authorityPosture: "none-resolved-mint" }))).toBe(
      "robust",
    );
    expect(k1("none-resolved-mint")).toBeNull();
    expect(k1("none-resolved")).toBeNull();
    expect(
      resolveOutlook(
        deepBelow(),
        coin({ authorityPosture: "none-resolved-mint", mintAuthorityScoreBand: "concentrated" }),
        surging(),
        baseLive(),
      ).factors.find((factor) => factor.code === "K1_supply_weaponization"),
    ).toMatchObject({ severity: "elevated" });
  });

  it("grants the mint-scoped value the weak R1 rung, never the strong one", () => {
    // DDR 4.2: `none-resolved-mint` is real evidence — this token has no minter
    // of its own — so it earns R1 at the weak rung alongside governance-bounded
    // user collateral. It cannot earn the strong rung, because the wrapped
    // parent can still print. Only strong anchors move the resolution tier, so
    // the weak rung is published attribution and shifts no verdict.
    const anchorFor = (posture: string) =>
      resolveOutlook(
        event({ direction: "below", peakDeviationBps: -300 }),
        coin({ authorityPosture: posture as DdrCoinStructural["authorityPosture"] }),
        baseSupply(),
        baseLive(),
      ).factors.find((factor) => factor.code === "R1_noninflatable_supply") ?? null;

    expect(anchorFor("none-resolved")).toMatchObject({ severity: "strong" });
    expect(anchorFor("none-resolved-mint")).toMatchObject({ kind: "anchor", severity: "weak" });
    expect(anchorFor("bounded-admin")).toBeNull();
  });

  it("keeps the immutable and governed mint paths ahead of the mint-scoped rung", () => {
    const anchorFor = (patch: Partial<DdrCoinStructural>) =>
      resolveOutlook(
        event({ direction: "below", peakDeviationBps: -300 }),
        coin({ authorityPosture: "none-resolved-mint", ...patch }),
        baseSupply(),
        baseLive(),
      ).factors.find((factor) => factor.code === "R1_noninflatable_supply") ?? null;

    expect(anchorFor({ mintPath: "immutable-user-collateralized" })).toMatchObject({ severity: "strong" });
    expect(anchorFor({ mintPath: "user-collateralized-governed" })).toMatchObject({
      severity: "weak",
      label: "User-collateralized supply (governance-bounded)",
    });
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
      baseLive({
        safetyScore: 92,
        safetyContext: { status: "v9-identified", reason: null, identity: null },
        liquidityScore: 80,
        redemptionCapacityRatio: 0.2,
        redemptionRouteFamily: "collateral-redeem",
      }),
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
      baseLive({
        safetyScore: 80,
        safetyContext: { status: "v9-identified", reason: null, identity: null },
        liquidityScore: 70,
        blacklistSurge: false,
      }),
    );
    expect(r.tier).not.toBe("recovery_unlikely");
  });

  it("does not project numeric recovery anchors from an unidentified safety context", () => {
    for (const status of ["unsupported-model", "identity-mismatch"] as const) {
      const r = resolveOutlook(
        event(),
        coin({ mechanismArchetype: "fiat-cash", authorityPosture: "concentrated-admin" }),
        baseSupply(),
        baseLive({ safetyScore: 99, safetyContext: { status, reason: "test", identity: null } }),
      );
      expect(r.factors.some((factor) => factor.code === "R5_proven_meanreversion")).toBe(false);
    }
  });

  it("maps identified V9 safety grades to the fixed R5 anchor bands", () => {
    const cases = [
      { grade: "A-", severity: "strong" },
      { grade: "B-", severity: "weak" },
      { grade: "C+", severity: undefined },
    ] as const;

    for (const { grade, severity } of cases) {
      const r = resolveOutlook(
        event({ direction: "above" }),
        coin(),
        baseSupply(),
        baseLive({
          safetyGrade: grade,
          safetyScore: 99,
          safetyContext: { status: "v9-identified", reason: null, identity: null },
        }),
      );
      const r5 = r.factors.find((factor) => factor.code === "R5_proven_meanreversion");
      expect(r5?.severity).toBe(severity);
    }
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
    expect(
      resolveOutlook(
        event(),
        coin({ mechanismArchetype: "cdp", authorityPosture: undefined }),
        baseSupply(),
        baseLive(),
      ).tier,
    ).toBe("insufficient_signal");
    expect(
      resolveOutlook(
        event(),
        structural,
        baseSupply({ covered: false, change7dPct: null, change30dPct: null, mintSurge: null }),
        baseLive(),
      ).tier,
    ).toBe("insufficient_signal");
    expect(resolveOutlook(event({ currentDeviationBps: null }), structural, baseSupply(), baseLive()).tier).toBe(
      "insufficient_signal",
    );
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
  it("emits K6 severe after an issuer-announced token wind-down", () => {
    const announcementDate = "2026-05-24";
    const lockAt = Date.UTC(2026, 5, 22) / 1000;
    const r = resolveOutlook(
      event({ stablecoinId: "usdr-stablr", direction: "below" }),
      coin({ authorityPosture: "none-resolved", mechanismArchetype: "fiat-cash", windDownAnnouncedAt: announcementDate }),
      baseSupply(),
      baseLive(),
      lockAt,
    );

    expect(r.factors).toContainEqual({
      code: "K6_wind_down",
      kind: "kill",
      severity: "severe",
      label: `Issuer announced wind-down on ${announcementDate}`,
    });
    expect(r.tier).toBe("recovery_unlikely");
  });

  it("emits K6 elevated at the wind-down fingerprint boundaries", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "wind-down-boundary", direction: "below" }),
      coin({ authorityPosture: "none-resolved", mechanismArchetype: "fiat-cash" }),
      baseSupply({ change30dPct: -40 }),
      baseLive({ tvlChange30d: -40 }),
    );

    expect(r.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "K6_wind_down",
          kind: "kill",
          severity: "elevated",
          label: expect.stringContaining("wind-down fingerprint"),
        }),
      ]),
    );
  });

  it("abstains when the wind-down fingerprint is outside a boundary or null-degraded", () => {
    const fixtures: Array<{
      name: string;
      supply: Partial<DdrSupplyContext>;
      live: Partial<DdrLiveContext & DdrWindDownFingerprintContext>;
    }> = [
      {
        name: "supply contraction above boundary",
        supply: { change30dPct: -39.99 },
        live: { tvlChange30d: -80 },
      },
      {
        name: "healthy exit trend",
        supply: { change30dPct: -50 },
        live: { tvlChange7d: -39.99, tvlChange30d: 10, volumeChange30d: 20 },
      },
      {
        name: "missing supply trend",
        supply: { change30dPct: null },
        live: { volumeChange30d: -90 },
      },
      {
        name: "missing exit trend",
        supply: { change30dPct: -50 },
        live: {},
      },
      {
        name: "MIM lock-time supply",
        supply: { change30dPct: -1.1 },
        live: { tvlChange30d: -90 },
      },
    ];

    for (const fixture of fixtures) {
      const r = resolveOutlook(
        event({ stablecoinId: fixture.name, direction: "below" }),
        coin({ authorityPosture: "none-resolved", mechanismArchetype: "fiat-cash" }),
        baseSupply(fixture.supply),
        baseLive(fixture.live),
      );

      expect(
        r.factors.some((factor) => factor.code === "K6_wind_down"),
        fixture.name,
      ).toBe(false);
    }
  });

  it("accepts a collapsing volume trend as the K6 elevated exit input", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "volume-collapse", direction: "below" }),
      coin({ authorityPosture: "none-resolved", mechanismArchetype: "fiat-cash" }),
      baseSupply({ change30dPct: -50 }),
      baseLive({ tvlChange7d: 5, tvlChange30d: 10, volumeChange30d: -40 }),
    );

    expect(r.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "K6_wind_down",
          severity: "elevated",
          label: expect.stringContaining("30-day DEX volume fell 40%"),
        }),
      ]),
    );
  });

  it("emits K6 elevated for GYEN's calm-catastrophic fingerprint", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "gyen-gyen", direction: "below", peakDeviationBps: -5_465 }),
      coin({
        authorityPosture: "reviewed-non-risky",
        mechanismArchetype: "fiat-cash",
        governance: "centralized",
      }),
      baseSupply({ change30dPct: 0 }),
      baseLive({ totalVolume24hUsd: 89 }),
    );

    expect(r.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "K6_wind_down",
          kind: "kill",
          severity: "elevated",
          label: expect.stringContaining("only $89 DEX volume / 24h"),
        }),
      ]),
    );
    expect(r.tier).toBe("at_risk");
  });

  it("abstains for PHT, USDXL, panicked-flow, and null-degraded calm events", () => {
    const fixtures: Array<{
      name: string;
      peakDeviationBps: number;
      supplyChange30dPct: number | null;
      totalVolume24hUsd: number | null;
    }> = [
      {
        name: "PHT depth floor",
        peakDeviationBps: -153,
        supplyChange30dPct: 0,
        totalVolume24hUsd: 0,
      },
      {
        name: "USDXL depth floor",
        peakDeviationBps: -233,
        supplyChange30dPct: 0,
        totalVolume24hUsd: 0,
      },
      {
        name: "USDC-SVB panicked flow",
        peakDeviationBps: -2_141,
        supplyChange30dPct: -2,
        totalVolume24hUsd: 50_000_000,
      },
      {
        name: "missing dead-volume input",
        peakDeviationBps: -5_465,
        supplyChange30dPct: 0,
        totalVolume24hUsd: null,
      },
      {
        name: "supply epsilon is strict",
        peakDeviationBps: -5_465,
        supplyChange30dPct: 5,
        totalVolume24hUsd: 89,
      },
    ];

    for (const fixture of fixtures) {
      const r = resolveOutlook(
        event({
          stablecoinId: fixture.name,
          direction: "below",
          peakDeviationBps: fixture.peakDeviationBps,
        }),
        coin({
          authorityPosture: "reviewed-non-risky",
          mechanismArchetype: "fiat-cash",
          governance: "centralized",
        }),
        baseSupply({ change30dPct: fixture.supplyChange30dPct }),
        baseLive({ totalVolume24hUsd: fixture.totalVolume24hUsd }),
      );

      expect(
        r.factors.some((factor) => factor.code === "K6_wind_down"),
        fixture.name,
      ).toBe(false);
    }
  });

  it("does not emit K6 for an announcement after the lock", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "mim-abracadabra", direction: "below" }),
      coin({
        authorityPosture: "none-resolved",
        mechanismArchetype: "cdp",
        windDownAnnouncedAt: "2026-06-24",
      }),
      baseSupply(),
      baseLive(),
      Date.UTC(2026, 5, 8) / 1000,
    );

    expect(r.factors.some((factor) => factor.code === "K6_wind_down")).toBe(false);
  });

  it("does not emit K6 for a venue wind-down absent from the coin record", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "usdxl-last", direction: "below" }),
      coin({ authorityPosture: "none-resolved", mechanismArchetype: "cdp" }),
      baseSupply(),
      baseLive(),
      Date.UTC(2026, 5, 18) / 1000,
    );

    expect(r.factors.some((factor) => factor.code === "K6_wind_down")).toBe(false);
  });

  it("emits K1 severe for a recent compromised mint incident observed by forecast lock", () => {
    const incidentAt = Date.UTC(2026, 4, 24) / 1000;
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -5000, startedAt: incidentAt - 12 * 3600 }),
      coin({
        authorityPosture: "concentrated-admin",
        mintPath: "issuer-direct-mint",
        mintIncidents: [{ date: "2026-05-24", status: "active" }],
      }),
      baseSupply({ mintSurge: false, change7dPct: 1 }),
      baseLive(),
      incidentAt + 86400,
    );
    expect(r.factors.some((f) => f.code === "K1_supply_weaponization" && f.severity === "severe")).toBe(true);
    expect(r.tier).toBe("recovery_unlikely");
  });

  it("ignores stale mint incidents outside the recent-incident window", () => {
    const incidentAt = Date.UTC(2026, 4, 24) / 1000;
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -5000, startedAt: incidentAt + 61 * 86400 }),
      coin({
        authorityPosture: "concentrated-admin",
        mintPath: "issuer-direct-mint",
        mintIncidents: [{ date: "2026-05-24", status: "active" }],
      }),
      baseSupply({ mintSurge: false, change7dPct: 1 }),
      baseLive(),
      incidentAt + 62 * 86400,
    );
    expect(r.factors.some((f) => f.code === "K1_supply_weaponization")).toBe(false);
    expect(r.tier).not.toBe("recovery_unlikely");
  });

  it("treats concentrated and exposed MAS bands as risky minters", () => {
    for (const mintAuthorityScoreBand of ["concentrated", "exposed"]) {
      const r = resolveOutlook(
        event({ direction: "below" }),
        coin({ authorityPosture: "reviewed-non-risky", mintAuthorityScoreBand }),
        baseSupply({ mintSurge: true }),
        baseLive(),
      );
      expect(r.factors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "K1_supply_weaponization", severity: "elevated" }),
        ]),
      );
    }
  });

  it("counts only unresolved mint incidents in the asymmetric event window", () => {
    const startedAt = Date.UTC(2026, 5, 1) / 1000;
    const r = resolveOutlook(
      event({ direction: "below", startedAt }),
      coin({
        authorityPosture: "concentrated-admin",
        mintPath: "issuer-direct-mint",
        mintIncidents: [
          { date: "2026-04-02", status: "active" },
          { date: "2026-06-08", status: "active" },
          { date: "2026-05-31", status: "resolved", resolvedAt: "2026-05-31" },
        ],
      }),
      baseSupply({ mintSurge: false, change7dPct: 0 }),
      baseLive(),
      startedAt + 7 * 86400,
    );

    expect(r.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "K1_supply_weaponization", severity: "elevated" }),
      ]),
    );

    const remediated = resolveOutlook(
      event({ direction: "below", startedAt }),
      coin({
        authorityPosture: "concentrated-admin",
        mintPath: "issuer-direct-mint",
        mintIncidents: [{ date: "2026-05-31", status: "resolved", resolvedAt: "2026-05-31" }],
      }),
      baseSupply({ mintSurge: false, change7dPct: 0 }),
      baseLive(),
      startedAt + 7 * 86400,
    );
    expect(remediated.factors.some((factor) => factor.code === "K1_supply_weaponization")).toBe(false);
  });

  it("keeps K2 severe for a genuinely impaired CDP", () => {
    const r = resolveOutlook(
      event({ direction: "below", peakDeviationBps: -3000 }),
      coin({
        mechanismArchetype: "cdp",
        authorityPosture: "none-resolved",
        reserves: [{ risk: "very-high", pct: 100 }],
        dependencyImpaired: true,
      }),
      baseSupply({ mintSurge: false, change7dPct: 0 }),
      baseLive(),
    );
    expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "severe")).toBe(true);
    expect(r.tier).toBe("recovery_unlikely");
  });

  it("does not emit static K2 for exotic CDP or synthetic collateral", () => {
    for (const mechanismArchetype of ["cdp", "synthetic-delta-neutral"]) {
      const r = resolveOutlook(
        event(),
        coin({
          mechanismArchetype,
          authorityPosture: "none-resolved",
          collateralQuality: "exotic",
          reserves: [{ risk: "very-high", pct: 100 }],
          dependencyImpaired: false,
        }),
        baseSupply(),
        baseLive(),
      );
      expect(r.factors.some((f) => f.code === "K2_backing_impairment")).toBe(false);
    }
  });

  it("keeps static very-high reserve concentration elevated for attested-reserve archetypes", () => {
    for (const mechanismArchetype of ["fiat-cash", "tbill", "rwa-credit-fund"]) {
      const r = resolveOutlook(
        event({ direction: "below", peakDeviationBps: -150 }),
        coin({
          mechanismArchetype,
          authorityPosture: "concentrated-admin",
          mintPath: "user-collateralized-governed",
          custodyModel: "onchain",
          reserves: [{ risk: "very-high", pct: 60 }],
          dependencyImpaired: false,
        }),
        baseSupply({ mintSurge: false, change7dPct: 0 }),
        baseLive({ liquidityScore: 50 }),
      );
      expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "elevated")).toBe(true);
      expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "severe")).toBe(false);
      expect(r.tier).toBe("at_risk");
    }
  });

  it("keeps very-high reserve concentration severe for attested-reserve archetypes on deep below-peg breaks", () => {
    for (const mechanismArchetype of ["fiat-cash", "tbill", "rwa-credit-fund"]) {
      const r = resolveOutlook(
        event({ direction: "below", peakDeviationBps: -3000 }),
        coin({
          mechanismArchetype,
          authorityPosture: "none-resolved",
          reserves: [{ risk: "very-high", pct: 60 }],
          dependencyImpaired: false,
        }),
        baseSupply({ mintSurge: false, change7dPct: 0 }),
        baseLive({ liquidityScore: 50 }),
      );
      expect(r.factors.some((f) => f.code === "K2_backing_impairment" && f.severity === "severe")).toBe(true);
      expect(r.tier).toBe("recovery_unlikely");
    }
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
      coin({
        mechanismArchetype: "cdp",
        authorityPosture: "concentrated-admin",
        mintPath: "user-collateralized-governed",
      }),
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

  it("uses a functioning measured V9 exit route as the R2 strong alternative", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", collateralQuality: "native" }),
      baseSupply(),
      baseLive({
        safetyContext: { status: "v9-identified", reason: null, identity: null },
        v9Exit: v9Exit(),
      }),
    );

    expect(r.factors).toContainEqual(
      expect.objectContaining({ code: "R2_hard_collateral_redemption", severity: "strong" }),
    );
  });

  it("uses measured V9 exit reasons and collapsed capacity for K5", () => {
    const fixtures: Array<{
      name: string;
      exit: DdrV9ExitContext;
      severity: "severe" | "elevated";
    }> = [
      {
        name: "no viable exit",
        exit: v9Exit({ reasonCodes: ["no-viable-exit-path"], primaryRoute: null }),
        severity: "severe",
      },
      {
        name: "correlated routes",
        exit: v9Exit({ reasonCodes: ["correlated-exit-routes"] }),
        severity: "elevated",
      },
      {
        name: "exhausted measured capacity",
        exit: v9Exit({
          primaryRoute: {
            key: "redemption:measured",
            score: 80,
            capacity: {
              executableUsd: 5_000,
              requestedNotionalUsd: 1_000_000,
              completionRatio: 0.005,
            },
          },
        }),
        severity: "severe",
      },
      {
        name: "thin measured capacity",
        exit: v9Exit({
          primaryRoute: {
            key: "redemption:measured",
            score: 80,
            capacity: {
              executableUsd: 40_000,
              requestedNotionalUsd: 1_000_000,
              completionRatio: 0.04,
            },
          },
        }),
        severity: "elevated",
      },
    ];

    for (const fixture of fixtures) {
      const r = resolveOutlook(
        event({ stablecoinId: fixture.name }),
        coin({ authorityPosture: "none-resolved" }),
        baseSupply(),
        baseLive({
          safetyContext: { status: "v9-identified", reason: null, identity: null },
          v9Exit: fixture.exit,
        }),
      );
      expect(r.factors).toContainEqual(
        expect.objectContaining({ code: "K5_exit_collapse", severity: fixture.severity }),
      );
    }
  });

  it("keeps V9 exit evidence null-degraded when the V9 publication is unavailable", () => {
    const r = resolveOutlook(
      event(),
      coin({ mechanismArchetype: "cdp", authorityPosture: "none-resolved", collateralQuality: "native" }),
      baseSupply(),
      baseLive({
        safetyContext: { status: "cache-unavailable", reason: "v9-publication-held", identity: null },
        v9Exit: v9Exit({ reasonCodes: ["no-viable-exit-path"] }),
      }),
    );

    expect(r.factors.some((factor) => factor.code === "K5_exit_collapse")).toBe(false);
    expect(r.factors).toContainEqual(
      expect.objectContaining({ code: "R2_hard_collateral_redemption", severity: "weak" }),
    );
  });

  it("keeps GYEN recovery_unlikely at lock when K6 and a strong V9 exit route both fire", () => {
    const r = resolveOutlook(
      event({ stablecoinId: "gyen-gyen", direction: "below", peakDeviationBps: -5_465 }),
      coin({
        authorityPosture: "reviewed-non-risky",
        mechanismArchetype: "fiat-cash",
        collateralQuality: "native",
        windDownAnnouncedAt: "2026-05-15",
      }),
      baseSupply({ change7dPct: 0, mintSurge: false }),
      baseLive({
        safetyContext: { status: "v9-identified", reason: null, identity: null },
        v9Exit: v9Exit(),
      }),
      1_782_084_906,
    );

    expect(r.factors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "K6_wind_down", severity: "severe" }),
        expect.objectContaining({ code: "R2_hard_collateral_redemption", severity: "strong" }),
      ]),
    );
    expect(r.tier).toBe("recovery_unlikely");
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
      coin({
        mechanismArchetype: "cdp",
        authorityPosture: "none-resolved",
        collateralQuality: "native",
        custodyModel: "cex",
      }),
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

  it("keeps live grouping at 6h while duration labels use 24h stickiness", () => {
    const events: DdrHistoricalEvent[] = [
      { stablecoinId: "a", direction: "below", peakDeviationBps: -300, startedAt: 0, endedAt: 3600, recoveryPrice: 1 },
      {
        stablecoinId: "a",
        direction: "below",
        peakDeviationBps: -500,
        startedAt: 3600 + 60,
        endedAt: 7200,
        recoveryPrice: 1,
      },
      {
        stablecoinId: "a",
        direction: "below",
        peakDeviationBps: -200,
        startedAt: 7200 + 12 * 3600,
        endedAt: 7200 + 13 * 3600,
        recoveryPrice: 1,
      },
      {
        stablecoinId: "a",
        direction: "below",
        peakDeviationBps: -200,
        startedAt: 7200 + 100 * 3600,
        endedAt: 7200 + 101 * 3600,
        recoveryPrice: 1,
      },
    ];
    const incidents = groupIncidents(events, usd);
    expect(incidents.length).toBe(3);
    const merged = incidents.find((i) => i.startedAt === 0)!;
    expect(Math.abs(merged.peakDeviationBps)).toBe(500); // worst across merged fragments
    expect(merged.recovered).toBe(true);

    const durationLabels = groupDurationLabelIncidents(incidents);
    expect(durationLabels.length).toBe(2);
    expect(durationLabels[0].durationSec).toBe(7200 + 13 * 3600);
  });

  it("quarantines the verified short-duration detector cohorts", () => {
    const usdbBlast = Array.from({ length: 764 }, (_, i) => incidentForQuarantine("usdb-blast", 7202, i));
    const cusdCelo = Array.from({ length: 410 }, (_, i) => incidentForQuarantine("cusd-celo", 3708, i));
    const ordinaryFlapper = Array.from({ length: 151 }, (_, i) => incidentForQuarantine("lisusd-lista", 3744, i));
    const twoHundred = Array.from({ length: 200 }, (_, i) => incidentForQuarantine("at-count-boundary", 60, i));
    const atMedianBoundary = Array.from({ length: 201 }, (_, i) => incidentForQuarantine("at-median-boundary", 2.01 * 3600, i));

    const q = quarantinedCoins([...usdbBlast, ...cusdCelo, ...ordinaryFlapper, ...twoHundred, ...atMedianBoundary]);

    expect(q.has("usdb-blast")).toBe(true);
    expect(q.has("cusd-celo")).toBe(true);
    expect(q.has("lisusd-lista")).toBe(false); // ordinary flappers stay in corpus; coin-dedup bounds them
    expect(q.has("at-count-boundary")).toBe(false); // strictly more than 200 incidents required
    expect(q.has("at-median-boundary")).toBe(false);
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
      {
        direction: "below",
        depths: ["moderate", "severe", "catastrophic"],
        structural: "__any__",
        currency: "__any__",
      },
    ]);
  });

  it("keeps non-USD history before pooling currencies", () => {
    expect(candidateStrata({ ...key, depth: "severe", currency: "non-USD" })).toEqual([
      { direction: "below", depths: ["severe"], structural: "robust", currency: "non-USD" },
      { direction: "below", depths: ["severe"], structural: "__any__", currency: "non-USD" },
      { direction: "below", depths: ["severe", "catastrophic"], structural: "__any__", currency: "non-USD" },
      { direction: "below", depths: ["moderate", "severe", "catastrophic"], structural: "__any__", currency: "non-USD" },
      { direction: "below", depths: ["severe"], structural: "__any__", currency: "__any__" },
      { direction: "below", depths: ["severe", "catastrophic"], structural: "__any__", currency: "__any__" },
      {
        direction: "below",
        depths: ["moderate", "severe", "catastrophic"],
        structural: "__any__",
        currency: "__any__",
      },
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

  it("publishes the p15/p85 typical range", () => {
    const incidents: DdrIncident[] = Array.from({ length: 20 }, (_, i) => ({
      stablecoinId: `quantile-${i}`,
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: i * 3 * 86400,
      endedAt: i * 3 * 86400 + (i + 1) * 3600,
      durationSec: (i + 1) * 3600,
      recovered: true,
    }));

    const d = computeDuration(key, 0, incidents, new Set());

    expect(d.iqrSec).toEqual([3.85 * 3600, 17.15 * 3600]);
  });

  it("coin-deduplicates the published median and typical range", () => {
    const flapper = Array.from({ length: 20 }, (_, i): DdrIncident => ({
      stablecoinId: "flapper",
      direction: "below",
      peakDeviationBps: -500,
      depth: "moderate",
      currency: "USD",
      structural: "robust",
      startedAt: i * 48 * 3600,
      endedAt: i * 48 * 3600 + 3600,
      durationSec: 3600,
      recovered: true,
    }));
    const otherCoins = [20, 30, 40, 50].map((hours, i): DdrIncident => ({
      stablecoinId: `other-${i}`,
      direction: "below",
      peakDeviationBps: -500,
      depth: "moderate",
      currency: "USD",
      structural: "robust",
      startedAt: (i + 20) * 48 * 3600,
      endedAt: (i + 20) * 48 * 3600 + hours * 3600,
      durationSec: hours * 3600,
      recovered: true,
    }));

    const d = computeDuration(key, 0, [...flapper, ...otherCoins], new Set());

    expect(d.suppressed).toBe(false);
    expect(d.medianSec).toBe(30 * 3600);
    expect(d.iqrSec).toEqual([12.4 * 3600, 44 * 3600]);
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
      currency: i % 2 === 0 ? ("USD" as const) : ("non-USD" as const),
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

  // weightedClosureStats — coin-capping tests
  it("caps each coin's contribution at 1.0 so a dominant coin cannot inflate the probability", () => {
    // "dominant" coin: 10 incidents all closing within 6h (durationSec = 6h).
    // 4 other coins: 1 incident each, very long duration (never closes at 6h horizon).
    // Without per-coin cap: 10/14 ≈ 0.71. With cap: 1.0/5 = 0.20.
    const dominantIncidents: DdrIncident[] = Array.from({ length: 10 }, (_, i) => ({
      stablecoinId: "dominant",
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      // Keep these as distinct training labels under the intentional 24h stickiness.
      startedAt: i * 48 * 3600,
      endedAt: i * 48 * 3600 + 6 * 3600,
      durationSec: 6 * 3600,
      recovered: true,
    }));
    const otherIncidents: DdrIncident[] = Array.from({ length: 4 }, (_, i) => ({
      stablecoinId: `other-${i}`,
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      startedAt: 1_000_000 + i * 1000,
      endedAt: 1_000_000 + i * 1000 + 30 * 86400,
      durationSec: 30 * 86400,
      recovered: true,
    }));
    const d = computeDuration(key, 0, [...dominantIncidents, ...otherIncidents], new Set());
    // Support gate: 14 incidents, 5 unique coins — passes thin_support threshold.
    const h6 = d.horizons.find((h) => h.horizon === "6h")!;
    expect(h6.state).toBe("thin_support");
    // Coin-capped probability is 1/5 = 0.20; uncapped would be ~0.71.
    expect(h6.probability).toBeCloseTo(0.2, 1);
  });

  it("marks a horizon as not displayable when effectiveN is below the thin-support floor", () => {
    // 4 unique coins × 4 incidents each = 16 incidents, but effectiveN = 4 < THIN_SUPPORT_MIN_EFFECTIVE_N (5).
    // All close within 6h so there ARE closures, but the per-coin support gate should block display.
    const incidents: DdrIncident[] = Array.from({ length: 16 }, (_, i) => ({
      stablecoinId: `coin-${i % 4}`,
      direction: "below" as const,
      peakDeviationBps: -500,
      depth: "moderate" as const,
      currency: "USD" as const,
      structural: "robust" as const,
      // Keep each coin's four episodes distinct after duration-label regrouping.
      startedAt: Math.floor(i / 4) * 48 * 3600,
      endedAt: Math.floor(i / 4) * 48 * 3600 + 6 * 3600,
      durationSec: 6 * 3600,
      recovered: true,
    }));
    const d = computeDuration(key, 0, incidents, new Set());
    const h6 = d.horizons.find((h) => h.horizon === "6h")!;
    // effectiveN = 4 < 5 → cannot reach thin_support; probability must be null.
    expect(h6.probability).toBeNull();
    expect(h6.state).not.toBe("thin_support");
    expect(h6.state).not.toBe("benchmarked");
  });

  it("uses fractional coin weights for Wilson intervals", () => {
    const incidents = Array.from({ length: 5 }, (_, i) => [
      {
        stablecoinId: `coin-${i}`,
        direction: "below" as const,
        peakDeviationBps: -500,
        depth: "moderate" as const,
        currency: "USD" as const,
        structural: "robust" as const,
        startedAt: i * 100 * 86400,
        endedAt: i * 100 * 86400 + 6 * 3600,
        durationSec: 6 * 3600,
        recovered: true,
      },
      {
        stablecoinId: `coin-${i}`,
        direction: "below" as const,
        peakDeviationBps: -500,
        depth: "moderate" as const,
        currency: "USD" as const,
        structural: "robust" as const,
        startedAt: i * 100 * 86400 + 48 * 3600,
        endedAt: i * 100 * 86400 + 48 * 3600 + 30 * 86400,
        durationSec: 30 * 86400,
        recovered: true,
      },
    ]).flat();

    const h6 = computeDuration(key, 0, incidents, new Set()).horizons.find((h) => h.horizon === "6h")!;

    expect(h6.state).toBe("thin_support");
    expect(h6.probability).toBe(0.5);
    expect(h6.probabilityInterval).toMatchObject({ lower: expect.closeTo(0.2043, 4), upper: expect.closeTo(0.7957, 4) });
  });

  it("interpolates p99 for chronic-tail detection", () => {
    const durations = [1, 2, 3, 100].map((hours, i): DdrIncident => ({
      stablecoinId: `tail-${i}`,
      direction: "below",
      peakDeviationBps: -500,
      depth: "moderate",
      currency: "USD",
      structural: "robust",
      startedAt: i * 200 * 3600,
      endedAt: i * 200 * 3600 + hours * 3600,
      durationSec: hours * 3600,
      recovered: true,
    }));

    expect(computeDuration(key, 98 * 3600, durations, new Set()).ageStatus).toBe("chronic_tail");
  });
});

describe("duration training corpus", () => {
  const trainingIncident = (
    stablecoinId: string,
    startedAt: number,
    endedAt: number,
  ): DdrIncident => ({
    stablecoinId,
    direction: "below",
    peakDeviationBps: -300,
    depth: "moderate",
    currency: "USD",
    structural: "fragile",
    startedAt,
    endedAt,
    durationSec: endedAt - startedAt,
    recovered: true,
  });

  it("pins the 24h-stickiness replay trainable count at 4,986", () => {
    // ref/ev_0.json + ref/ev_12000.json, compacted as
    // [6h-group count, 6h-trainable count, 24h-trainable, occurrence count].
    const referenceCorpusShape = [
      [1, 0, 0, 59],
      [1, 1, 1, 3465],
      [2, 0, 0, 2],
      [2, 0, 1, 8],
      [2, 1, 0, 3],
      [2, 1, 1, 15],
      [2, 2, 1, 734],
      [3, 1, 1, 1],
      [3, 2, 1, 4],
      [3, 3, 1, 308],
      [4, 1, 1, 1],
      [4, 2, 1, 1],
      [4, 3, 1, 3],
      [4, 4, 1, 157],
      [5, 3, 1, 2],
      [5, 5, 1, 84],
      [6, 4, 1, 1],
      [6, 5, 1, 4],
      [6, 6, 1, 57],
      [7, 6, 1, 1],
      [7, 7, 1, 30],
      [8, 8, 1, 26],
      [9, 9, 1, 23],
      [10, 8, 1, 1],
      [10, 9, 0, 1],
      [10, 10, 1, 9],
      [11, 11, 1, 12],
      [12, 11, 1, 1],
      [12, 12, 1, 8],
      [13, 13, 1, 4],
      [14, 14, 1, 6],
      [15, 15, 1, 4],
      [16, 16, 1, 1],
      [17, 16, 1, 1],
      [17, 17, 1, 2],
      [18, 18, 1, 3],
      [19, 19, 1, 1],
      [20, 20, 1, 1],
      [21, 21, 1, 2],
      [22, 22, 1, 3],
      [30, 30, 1, 1],
      [37, 37, 1, 1],
    ] as const;
    const corpus: DdrIncident[] = [];
    let groupIndex = 0;
    let inputTrainableCount = 0;

    for (const [fragmentCount, trainableCount, labelTrainable, occurrences] of referenceCorpusShape) {
      for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
        let startedAt = groupIndex * 100 * DURATION_LABEL_MERGE_GAP_SEC;
        for (let fragment = 0; fragment < fragmentCount; fragment += 1) {
          const trainable = fragment < trainableCount;
          const durationSec = trainable ? 3600 : 60;
          const incident = trainingIncident(`reference-group-${groupIndex}`, startedAt, startedAt + durationSec);
          incident.peakDeviationBps = trainable ? -300 : -100;
          incident.depth = trainable ? "moderate" : "minor";
          if (!labelTrainable && fragment === fragmentCount - 1) incident.recovered = false;
          corpus.push(incident);
          if (trainable) inputTrainableCount += 1;
          startedAt = incident.endedAt! + 12 * 3600;
        }
        groupIndex += 1;
      }
    }

    expect(corpus).toHaveLength(8_950);
    expect(inputTrainableCount).toBe(8_823);
    expect(groupDurationLabelIncidents(corpus)).toHaveLength(5_051);
    expect(buildDurationTrainingCorpus(corpus, new Set())).toHaveLength(4_986);
  });

  it("pins reviewed sticky duration labels from the reference event fixture", () => {
    const fixtures: Array<{ eventId: number; expectedHours: number; incident: DdrIncident }> = [
      {
        eventId: 90635,
        expectedHours: 103.5,
        incident: {
          ...trainingIncident("krwq-iq", 1783938776, 1784311438),
          direction: "above",
          peakDeviationBps: 200,
          depth: "minor",
          currency: "non-USD",
          fragments: [
            { offsetSec: 0, peakDeviationBps: 200 },
            { offsetSec: 1784310476 - 1783938776, peakDeviationBps: 150 },
          ],
        },
      },
      {
        eventId: 90508,
        expectedHours: 235.7,
        incident: {
          ...trainingIncident("zarp-zarp", 1782754527, 1783603173),
          peakDeviationBps: -442,
          depth: "moderate",
          currency: "non-USD",
          structural: "robust",
          fragments: [
            { offsetSec: 0, peakDeviationBps: -256 },
            { offsetSec: 1783599578 - 1782754527, peakDeviationBps: -159 },
          ],
        },
      },
      {
        eventId: 90285,
        expectedHours: 561.5,
        incident: {
          ...trainingIncident("usda-alpha-partner", 1780627004, 1782648326),
          peakDeviationBps: -626,
          depth: "moderate",
          fragments: [
            { offsetSec: 0, peakDeviationBps: -504 },
            { offsetSec: 1782029942 - 1780627004, peakDeviationBps: -397 },
          ],
        },
      },
    ];

    const labels = buildDurationTrainingCorpus(fixtures.map((fixture) => fixture.incident), new Set());

    for (const fixture of fixtures) {
      const label = labels.find((incident) => incident.stablecoinId === fixture.incident.stablecoinId);
      expect(label?.durationSec, `ev${fixture.eventId}`).toBeDefined();
      expect((label!.durationSec as number) / 3600, `ev${fixture.eventId}`).toBeCloseTo(fixture.expectedHours, 1);
    }
  });
});

describe("resolveDepeg orchestration", () => {
  it("suppresses duration for a terminal verdict", () => {
    const row = resolveDepeg({
      active: event({ stablecoinId: "usr-resolv", direction: "below", peakDeviationBps: -9025 }),
      coin: coin({
        authorityPosture: "unbounded-or-compromised",
        mintPath: "offchain-attested-minter",
        governance: "centralized",
      }),
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
