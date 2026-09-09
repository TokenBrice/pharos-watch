import { describe, expect, it } from "vitest";
import type {
  DdrFactorCode,
  DdrFactorKind,
  DdrFactorSeverity,
  DdrResolutionTier,
} from "../../../types/depeg-resolver";
import type { DepegDirection } from "../../../types/market";
import {
  resolveDepeg,
  resolveOutlook,
  type DdrResolveInput,
  type DdrSafetyContextProvenance,
  type DdrSafetyContextStatus,
  type DdrWindDownFingerprintContext,
} from "../index";
import lockedVerdictFixtureJson from "./fixtures/locked-verdict-replay.json";

/**
 * The fixture's `lockTime` / `recordedDuration` blocks are read back from the
 * sealed public-prediction payloads in production D1 — see
 * `./fixtures/locked-verdict-replay.README.md` for the extraction query. Those
 * fields, plus `expectedTier` and `sourceFactors`, are lock-time evidence.
 *
 * Registry structure is *not* recoverable: nothing stores the lock-time value of
 * `mechanismArchetype`, `mintPath`, `authorityPosture`, `collateralQuality`,
 * `custodyModel`, `reserves`, `canBeBlacklisted`, `dependencyImpaired`,
 * `windDownAnnouncedAt`, the redemption-backstop fields, the incident history
 * behind R5, or the DEX/TVL trend inputs. Those stay a synthetic reconstruction
 * back-solved from the recorded attributions, so a matching resolver verdict is
 * scenario agreement rather than historical replay.
 */

interface LockedFactorAttribution {
  code: DdrFactorCode;
  kind: DdrFactorKind;
  severity: DdrFactorSeverity;
}

/** Lock-time context recorded in `sealed_payload_json`. */
interface LockedTimeEvidence {
  registryStatus: string | null;
  peakDeviationBps: number;
  currentDeviationBps: number;
  supplyChange7dPct: number | null;
  supplyChange30dPct: number | null;
  mintSurge: boolean;
  liquidityScore: number | null;
  dewsBand: string | null;
  dewsScore: number | null;
  safetyGrade: string | null;
  safetyScore: number | null;
  safetyContextStatus: string | null;
}

/** Duration verdict recorded alongside the sealed resolution. */
interface LockedRecordedDuration {
  suppressed: boolean;
  suppressedReason: string | null;
  medianSec: number | null;
  ageStatus: string | null;
}

interface LockedVerdictRow {
  rowId: string;
  publicPredictionId: number;
  eventId: number;
  startedAt: number;
  lockedAt: number;
  stablecoinId: string;
  symbol: string;
  pegCurrency: string;
  governance: string;
  direction: DepegDirection;
  expectedTier: DdrResolutionTier;
  verdictReview: string;
  abovePegControl: boolean;
  knownMiss: "risk_noted_terminal" | "false_terminal" | null;
  sourceFactors: LockedFactorAttribution[];
  lockTime: LockedTimeEvidence;
  recordedDuration: LockedRecordedDuration;
}

interface LockedVerdictFixture {
  schemaVersion: 2;
  source: string;
  lockTimeEvidence: {
    database: string;
    columns: string[];
    extraction: string;
  };
  rows: LockedVerdictRow[];
}

interface ExpectedDelta {
  taskId: string;
  rowId: string;
  from: DdrResolutionTier;
  to: DdrResolutionTier;
  reason: string;
}

interface ExpectedFactorOnlyDelta {
  taskId: string;
  rowId: string;
  code: DdrFactorCode;
  reason: string;
}

/** DEX / TVL trend inputs, which no lock-time record preserves. */
interface LockedDexContext {
  tvlChange7d: number | null;
  tvlChange30d: number | null;
  volumeChange30d: number | null;
  totalVolume24hUsd?: number | null;
}

const fixture = lockedVerdictFixtureJson as unknown as LockedVerdictFixture;

const WIND_DOWN_ANNOUNCEMENTS: Readonly<Record<string, string>> = {
  "usdr-stablr": "2026-05-24",
  "eurr-stablr": "2026-05-24",
  "gyen-gyen": "2026-05-15",
  "mim-abracadabra": "2026-06-24",
};

// Synthetic reconstruction: DEX/TVL trends are not part of the sealed record.
const SYNTHETIC_DEX_CONTEXT: Readonly<Record<string, LockedDexContext>> = {
  "ddrr-66": { tvlChange7d: -7.3013, tvlChange30d: -8.7959, volumeChange30d: -100 },
  "ddrr-48": { tvlChange7d: -0.0228, tvlChange30d: -16.6083, volumeChange30d: -100 },
  "ddrr-30": { tvlChange7d: 15.3012, tvlChange30d: -87.0387, volumeChange30d: -99.9989 },
  "ddrr-29": {
    tvlChange7d: 0.0015,
    tvlChange30d: -0.0572,
    volumeChange30d: 790,
    totalVolume24hUsd: 89,
  },
  "ddrr-24": { tvlChange7d: 24.9452, tvlChange30d: 37.3423, volumeChange30d: 306.8819 },
  "ddrr-22": { tvlChange7d: 13.8109, tvlChange30d: 35.9855, volumeChange30d: 68.9466 },
  "ddrr-18": { tvlChange7d: -0.4497, tvlChange30d: -7.2195, volumeChange30d: 4.2618 },
  "ddrr-17": { tvlChange7d: 11.1406, tvlChange30d: null, volumeChange30d: null },
  "ddrr-13": { tvlChange7d: 11.0998, tvlChange30d: null, volumeChange30d: null },
  "ddrr-12": { tvlChange7d: -74.5135, tvlChange30d: 12982.6316, volumeChange30d: 40.2108 },
  "ddrr-8": { tvlChange7d: -4.3924, tvlChange30d: -62.1001, volumeChange30d: -42.7978 },
  "ddrr-7": { tvlChange7d: -0.7994, tvlChange30d: -0.5038, volumeChange30d: -90.723 },
  "ddrr-4": { tvlChange7d: 96.5062, tvlChange30d: 518.8116, volumeChange30d: null },
};

// Sealed payloads predate the V9-only provenance union: a v8 identification
// supplies no V9 anchors, which the current union spells `unsupported-model`.
const SAFETY_CONTEXT_STATUS_BY_RECORD: Readonly<Record<string, DdrSafetyContextStatus>> = {
  "v9-identified": "v9-identified",
  "v8-identified": "unsupported-model",
  "unsupported-model": "unsupported-model",
};

// Rubric tasks append only intentional verdict changes here. Any other replay
// delta remains a failure.
const EXPECTED_DELTAS: ExpectedDelta[] = [
  {
    taskId: "REM-D",
    rowId: "ddrr-67",
    from: "recovery_likely",
    to: "at_risk",
    reason: "cEUR's registry has neither native collateral nor qualifying reserves for the fabricated strong R2 anchor.",
  },
  {
    taskId: "T2.4",
    rowId: "ddrr-48",
    from: "recovery_unlikely",
    to: "at_risk",
    reason: "PHT's CDP mechanism makes static exotic collateral insufficient for K2.",
  },
  {
    taskId: "T2.1",
    rowId: "ddrr-30",
    from: "at_risk",
    to: "recovery_unlikely",
    reason: "USDR's issuer-announced wind-down predates the prediction lock.",
  },
  {
    taskId: "T2.1",
    rowId: "ddrr-29",
    from: "at_risk",
    to: "recovery_unlikely",
    reason: "GYEN's issuer-announced wind-down predates the prediction lock.",
  },
  {
    taskId: "T2.4",
    rowId: "ddrr-24",
    from: "recovery_unlikely",
    to: "at_risk",
    reason: "USDXL's CDP mechanism makes static reserve concentration insufficient for severe K2.",
  },
  {
    taskId: "T2.4",
    rowId: "ddrr-17",
    from: "recovery_unlikely",
    to: "at_risk",
    reason: "USDXL's CDP mechanism makes static reserve concentration insufficient for K2.",
  },
  {
    taskId: "T2.1",
    rowId: "ddrr-12",
    from: "at_risk",
    to: "recovery_unlikely",
    reason: "EURR's issuer-announced wind-down predates the prediction lock.",
  },
  {
    taskId: "T2.4",
    rowId: "ddrr-3",
    from: "recovery_unlikely",
    to: "at_risk",
    reason:
      "Mechanism-gated K2 accepts downgrading one reflexive-collateral CDP terminal to an at_risk hedge.",
  },
  {
    taskId: "REM-D",
    rowId: "ddrr-2",
    from: "at_risk",
    to: "recovery_unlikely",
    reason: "WEUSD's fiat-cash/exotic registry profile adds elevated K2 alongside elevated K5.",
  },
];

const EXPECTED_FACTOR_ONLY_DELTAS: ExpectedFactorOnlyDelta[] = [
  {
    taskId: "T2.2",
    rowId: "ddrr-30",
    code: "K6_wind_down",
    reason: "USDR's recorded lock-time supply collapse plus synthetic DEX trends add the wind-down fingerprint to its existing severe K6 factor.",
  },
  {
    taskId: "T2.3",
    rowId: "ddrr-29",
    code: "K6_wind_down",
    reason: "GYEN's catastrophic recorded depth, flat recorded supply, and $89 synthetic DEX volume add calm-catastrophic evidence to its existing severe K6 factor.",
  },
];

const STATIC_K2_REGISTRY_ROWS = new Set([
  "ddrr-48",
  "ddrr-27",
  "ddrr-24",
  "ddrr-22",
  "ddrr-17",
  "ddrr-13",
  "ddrr-3",
]);

const R2_REGISTRY_REPLAY_OVERRIDES: Readonly<
  Record<string, Partial<DdrResolveInput["coin"]>>
> = {
  "ddrr-67": {
    mechanismArchetype: "fiat-cash",
    collateralQuality: "alt-lst-bridged-or-mixed",
  },
  "ddrr-2": {
    mechanismArchetype: "fiat-cash",
    collateralQuality: "exotic",
    custodyModel: "onchain",
    canBeBlacklisted: "possible",
  },
};

function sourceFactor(
  row: LockedVerdictRow,
  code: DdrFactorCode,
): LockedFactorAttribution | undefined {
  return row.sourceFactors.find((factor) => factor.code === code);
}

function tierFromAttributions(
  direction: DepegDirection,
  factors: LockedFactorAttribution[],
): DdrResolutionTier {
  const kills = factors.filter((factor) => factor.kind === "kill");
  const anchors = factors.filter((factor) => factor.kind === "anchor");

  if (direction === "above") {
    return kills.some((factor) => factor.code === "K5_exit_collapse")
      ? "at_risk"
      : "recovery_likely";
  }

  const severeKills = kills.filter((factor) => factor.severity === "severe").length;
  const strongAnchors = anchors.filter((factor) => factor.severity === "strong");
  const hasStrongStructuralAnchor = strongAnchors.some(
    (factor) =>
      factor.code === "R1_noninflatable_supply" ||
      factor.code === "R2_hard_collateral_redemption",
  );

  if (severeKills >= 1 || (kills.length >= 2 && !hasStrongStructuralAnchor)) {
    return "recovery_unlikely";
  }
  if (kills.length === 0 && strongAnchors.length >= 2 && hasStrongStructuralAnchor) {
    return "recovery_likely";
  }
  return "at_risk";
}

function reconstructResolutionInput(row: LockedVerdictRow): DdrResolveInput {
  const k1 = sourceFactor(row, "K1_supply_weaponization");
  const k2 = sourceFactor(row, "K2_backing_impairment");
  const k3 = sourceFactor(row, "K3_freeze_seizure");
  const k4 = sourceFactor(row, "K4_reflexive_spiral");
  const k5 = sourceFactor(row, "K5_exit_collapse");
  const r1 = sourceFactor(row, "R1_noninflatable_supply");
  const r2 = sourceFactor(row, "R2_hard_collateral_redemption");
  const r4 = sourceFactor(row, "R4_no_freeze_point");
  const evidence = row.lockTime;
  const dex = SYNTHETIC_DEX_CONTEXT[row.rowId];
  const safetyContext: DdrSafetyContextProvenance | undefined =
    evidence.safetyContextStatus == null
      ? undefined
      : {
          status: SAFETY_CONTEXT_STATUS_BY_RECORD[evidence.safetyContextStatus] ?? "unsupported-model",
          reason: null,
          identity: null,
        };
  const supply: DdrResolveInput["supply"] = {
    covered: evidence.supplyChange7dPct != null,
    change7dPct: evidence.supplyChange7dPct,
    change30dPct: evidence.supplyChange30dPct,
    mintSurge: evidence.mintSurge,
  };
  const coin: DdrResolveInput["coin"] = {
    id: row.stablecoinId,
    symbol: row.symbol,
    name: row.symbol,
    pegCurrency: row.pegCurrency,
    governance: row.governance,
    status: evidence.registryStatus,
    authorityPosture: "reviewed-non-risky",
    dependencyImpaired: false,
    windDownAnnouncedAt: WIND_DOWN_ANNOUNCEMENTS[row.stablecoinId],
  };
  const live: DdrResolveInput["live"] & DdrWindDownFingerprintContext = {
    safetyContext,
    dewsBand: evidence.dewsBand,
    dewsScore: evidence.dewsScore,
    liquidityScore: evidence.liquidityScore,
    safetyGrade: evidence.safetyGrade,
    safetyScore: evidence.safetyScore,
    tvlChange7d: dex?.tvlChange7d ?? null,
    tvlChange30d: dex?.tvlChange30d ?? null,
    volumeChange30d: dex?.volumeChange30d ?? null,
    totalVolume24hUsd: dex?.totalVolume24hUsd ?? null,
  };

  if (r1?.severity === "strong") {
    coin.mintPath = "immutable-user-collateralized";
  } else if (r1?.severity === "weak") {
    coin.mintPath = "user-collateralized-governed";
  }

  if (r2?.severity === "strong") {
    coin.collateralQuality = "native";
    live.redemptionCapacityRatio = 0.2;
    live.redemptionRouteFamily = "collateral-redeem";
  } else if (r2?.severity === "weak") {
    coin.mechanismArchetype = "cdp";
  }
  Object.assign(coin, R2_REGISTRY_REPLAY_OVERRIDES[row.rowId]);

  if (k1) {
    coin.authorityPosture =
      k1.severity === "severe" ? "unbounded-or-compromised" : "concentrated-admin";
    coin.mintPath = "issuer-direct-mint";
  }

  if (k2) {
    if (STATIC_K2_REGISTRY_ROWS.has(row.rowId)) {
      if (k2.severity === "severe") {
        coin.reserves = [{ risk: "very-high", pct: 100 }];
      } else {
        coin.collateralQuality = "exotic";
      }
    } else if (k2.severity === "severe") {
      coin.dependencyImpaired = true;
    } else {
      coin.mechanismArchetype = "fiat-cash";
      coin.collateralQuality = "rwa";
      coin.reserves = [{ risk: "high", pct: 50 }];
    }
  }

  if (k3?.severity === "severe") {
    coin.custodyModel = "institutional-sanctioned";
  } else if (k3?.severity === "elevated") {
    coin.custodyModel = "cex";
  }

  if (k4) {
    coin.mechanismArchetype = "algorithmic";
  }

  if (k5?.severity === "severe") {
    live.tvlChange7d = -50;
  }

  if (r4?.severity === "strong") {
    coin.governance = "decentralized";
    coin.custodyModel = "onchain";
    coin.canBeBlacklisted = false;
  } else if (r4?.severity === "weak" && coin.governance !== "decentralized") {
    coin.custodyModel = "onchain";
  }

  return {
    active: {
      id: row.eventId,
      stablecoinId: row.stablecoinId,
      symbol: row.symbol,
      pegType: `pegged${row.pegCurrency}`,
      direction: row.direction,
      peakDeviationBps: evidence.peakDeviationBps,
      startedAt: row.startedAt,
      pegReference: 1,
      currentDeviationBps: evidence.currentDeviationBps,
    },
    coin,
    supply,
    live,
    nowSec: row.lockedAt,
    incidents: [],
    quarantined: new Set(),
  };
}

describe("locked DDR verdicts: recorded lock-time evidence plus synthetic registry structure", () => {
  it("pins the 72-row corpus, 13 reviewed above-peg controls, and six known misses", () => {
    expect(fixture.schemaVersion).toBe(2);
    expect(fixture.rows).toHaveLength(72);
    expect(new Set(fixture.rows.map((row) => row.rowId)).size).toBe(72);

    const abovePegControls = fixture.rows.filter((row) => row.abovePegControl);
    expect(abovePegControls).toHaveLength(13);
    expect(
      abovePegControls.every(
        (row) => row.direction === "above" && row.verdictReview === "correct_recoverable",
      ),
    ).toBe(true);

    expect(
      fixture.rows
        .filter((row) => row.knownMiss != null)
        .map((row) => `${row.rowId}:${row.stablecoinId}:${row.knownMiss}`),
    ).toEqual([
      "ddrr-48:pht-pht:false_terminal",
      "ddrr-30:usdr-stablr:risk_noted_terminal",
      "ddrr-29:gyen-gyen:risk_noted_terminal",
      "ddrr-18:mim-abracadabra:risk_noted_terminal",
      "ddrr-17:usdxl-last:false_terminal",
      "ddrr-12:eurr-stablr:risk_noted_terminal",
    ]);
  });

  it("carries a lock-time registry status for every row and never a frozen one", () => {
    // Both independent records — the sealed payload's own `sourceRow.status` and
    // the incident policy-membership registry snapshot — hold JSON null at lock
    // time, so no row may be reconstructed as a frozen/terminal coin.
    expect(
      fixture.rows.filter((row) => row.lockTime.registryStatus !== null).map((row) => row.rowId),
    ).toEqual([]);
    expect(
      fixture.rows
        .map((row) => row.lockTime.safetyContextStatus)
        .filter((status) => status != null && !(status in SAFETY_CONTEXT_STATUS_BY_RECORD)),
    ).toEqual([]);
  });

  it("suppresses the recorded duration exactly on the recorded terminal verdicts", () => {
    const terminalRows = fixture.rows.filter((row) => row.expectedTier === "recovery_unlikely");
    expect(terminalRows.map((row) => row.rowId)).toEqual([
      "ddrr-66",
      "ddrr-48",
      "ddrr-28",
      "ddrr-27",
      "ddrr-24",
      "ddrr-17",
      "ddrr-8",
      "ddrr-3",
    ]);
    expect(
      terminalRows.filter(
        (row) => !row.recordedDuration.suppressed || row.recordedDuration.medianSec != null,
      ),
    ).toEqual([]);
    expect(
      fixture.rows
        .filter((row) => row.recordedDuration.suppressedReason === "verdict_terminal")
        .map((row) => row.rowId),
    ).toEqual(terminalRows.map((row) => row.rowId));
  });

  it("derives every recorded tier from its recorded attributions with no frozen-status escape", () => {
    for (const row of fixture.rows) {
      expect(tierFromAttributions(row.direction, row.sourceFactors), row.rowId).toBe(
        row.expectedTier,
      );
    }
  });

  it("compares recorded-context scenarios through resolveOutlook and resolveDepeg", () => {
    const observedDeltas: Pick<ExpectedDelta, "rowId" | "from" | "to">[] = [];
    const fingerprintFactorRows: Pick<ExpectedFactorOnlyDelta, "rowId" | "code">[] = [];

    for (const row of fixture.rows) {
      const input = reconstructResolutionInput(row);
      const outlook = resolveOutlook(
        input.active,
        input.coin,
        input.supply,
        input.live,
        input.nowSec,
      );
      const resolved = resolveDepeg(input);

      expect(resolved.resolution.tier, `${row.rowId}: resolveDepeg/resolveOutlook drift`).toBe(
        outlook.tier,
      );
      if (resolved.resolution.tier !== row.expectedTier) {
        observedDeltas.push({
          rowId: row.rowId,
          from: row.expectedTier,
          to: resolved.resolution.tier,
        });
      }
      const fingerprintOnly = resolveDepeg({
        ...input,
        coin: { ...input.coin, windDownAnnouncedAt: undefined },
      });
      const fingerprintFactor = fingerprintOnly.resolution.factors.find(
        (factor) => factor.code === "K6_wind_down",
      );
      if (fingerprintFactor) {
        expect(fingerprintFactor).toMatchObject({ kind: "kill", severity: "elevated" });
        expect(fingerprintOnly.resolution.tier).toBe("at_risk");
        expect(resolved.resolution.factors.find((factor) => factor.code === "K6_wind_down"))
          .toMatchObject({ kind: "kill", severity: "severe" });
        expect(resolved.resolution.tier).toBe("recovery_unlikely");
        fingerprintFactorRows.push({
          rowId: row.rowId,
          code: fingerprintFactor.code,
        });
      }
    }

    expect(new Set(EXPECTED_DELTAS.map((delta) => delta.rowId)).size).toBe(
      EXPECTED_DELTAS.length,
    );
    for (const delta of EXPECTED_DELTAS) {
      const sourceRow = fixture.rows.find((row) => row.rowId === delta.rowId);
      expect(sourceRow, `unknown expected-delta row ${delta.rowId}`).toBeDefined();
      expect(delta.taskId.length).toBeGreaterThan(0);
      expect(delta.reason.length).toBeGreaterThan(0);
      expect(delta.from).toBe(sourceRow?.expectedTier);
    }

    expect(observedDeltas).toEqual(
      EXPECTED_DELTAS.map(({ rowId, from, to }) => ({ rowId, from, to })),
    );
    for (const delta of EXPECTED_FACTOR_ONLY_DELTAS) {
      expect(fixture.rows.some((row) => row.rowId === delta.rowId)).toBe(true);
      expect(["T2.2", "T2.3"]).toContain(delta.taskId);
      expect(delta.reason.length).toBeGreaterThan(0);
    }
    // EURR (`ddrr-12`) previously carried a T2.2 fingerprint expectation resting
    // on a -51% 30d supply value; the sealed record shows +18.7% at lock, so the
    // wind-down supply fingerprint legitimately no longer fires for it.
    expect(fingerprintFactorRows).toEqual(
      EXPECTED_FACTOR_ONLY_DELTAS.map(({ rowId, code }) => ({ rowId, code })),
    );
    expect(fingerprintFactorRows.map((row) => row.rowId)).not.toContain("ddrr-12");
    expect(fingerprintFactorRows.map((row) => row.rowId)).not.toContain("ddrr-18");
    expect(fingerprintFactorRows.map((row) => row.rowId)).not.toContain("ddrr-7");
  });
});
