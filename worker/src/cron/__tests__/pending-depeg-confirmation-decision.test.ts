import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import {
  DEPEG_PENDING_EXPIRY_SEC,
  DEPEG_PENDING_MIN_AGE_SEC,
} from "../../lib/constants";
import { normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import type {
  CollectedConfirmationEvidence,
  ConfirmationPlanReady,
} from "../pending-depeg-confirmation";
import { evaluatePromotionDecision } from "../pending-depeg-confirmation-decision";

const NOW_SEC = 1_700_000_000;
const openSqliteDatabases: DatabaseSync[] = [];

function openFixture(): { sqlite: DatabaseSync; db: D1Database } {
  const fixture = createLatestSchemaSqlite();
  openSqliteDatabases.push(fixture.sqlite);
  return fixture;
}

function makePendingRow(overrides: Partial<PendingDepegRow> = {}): PendingDepegRow {
  const firstSeenAt = overrides.first_seen_at ?? NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60;
  const firstSeenBps = overrides.first_seen_bps ?? -220;
  const firstPrice = overrides.first_price ?? 0.978;
  return {
    id: 1,
    stablecoin_id: "usdt-tether",
    symbol: "USDT",
    peg_type: "peggedUSD",
    direction: "below",
    first_seen_bps: firstSeenBps,
    first_seen_at: firstSeenAt,
    first_price: firstPrice,
    last_seen_bps: firstSeenBps,
    last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC,
    last_price: firstPrice,
    peak_seen_bps: null,
    peak_price: null,
    peg_reference: 1,
    reason: "large-cap",
    updated_at: firstSeenAt,
    ...overrides,
  };
}

function insertPending(sqlite: DatabaseSync, row: PendingDepegRow): void {
  sqlite.prepare(
    `INSERT INTO depeg_pending (
       id, stablecoin_id, symbol, peg_type, direction, first_seen_bps,
       first_seen_at, first_price, peg_reference, reason, last_seen_bps,
       last_seen_at, last_price, peak_seen_bps, peak_price, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.stablecoin_id,
    row.symbol,
    row.peg_type,
    row.direction,
    row.first_seen_bps,
    row.first_seen_at,
    row.first_price,
    row.peg_reference,
    row.reason ?? "large-cap",
    row.last_seen_bps,
    row.last_seen_at,
    row.last_price,
    row.peak_seen_bps,
    row.peak_price,
    row.updated_at ?? row.last_seen_at ?? row.first_seen_at,
  );
}

function emptyEvidence(): CollectedConfirmationEvidence {
  return {
    confirmingSources: [],
    opposingSources: [],
    unavailableSources: [],
    circuitOpenSources: [],
    hardOpposingSources: [],
    offchainStatus: "insufficient",
    offchainSourceKey: null,
    offchainPeakCandidate: null,
    dexStatus: "insufficient",
    dexPeakCandidates: [],
    dexConfirmationKeys: [],
    cexStatus: "insufficient",
    cexPeakCandidate: null,
    poolStatus: "insufficient",
    poolConfirmations: [],
  };
}

function makePlan(overrides: Partial<ConfirmationPlanReady> = {}): ConfirmationPlanReady {
  const row = overrides.row ?? makePendingRow();
  const pendingState = overrides.pendingState ?? normalizePendingDepegRow(row);
  return {
    asset: makeAsset({
      id: row.stablecoin_id,
      symbol: row.symbol,
      geckoId: undefined,
      price: 0.94,
    }),
    meta: undefined,
    pegReference: 1,
    threshold: 100,
    secondaryBar: 100,
    nativeSignal: null,
    nativePegQuote: undefined,
    nativeSourceKey: "native:usd",
    authoritativePrice: 0.94,
    primaryStatus: "insufficient",
    primarySameDirectionDepegged: false,
    primaryConfirmationSources: [],
    temporalSameDirectionConfirmed: false,
    age: DEPEG_PENDING_MIN_AGE_SEC + 60,
    evidence: emptyEvidence(),
    ...overrides,
    kind: "ready",
    row,
    pendingState,
    outcomeState: overrides.outcomeState ?? { ...pendingState },
  };
}

function makeEvidence(overrides: Partial<CollectedConfirmationEvidence> = {}): CollectedConfirmationEvidence {
  return { ...emptyEvidence(), ...overrides };
}

function readLifecycle(sqlite: DatabaseSync, stablecoinId: string, pendingId: number) {
  return {
    pending: sqlite.prepare("SELECT id FROM depeg_pending WHERE id = ?").get(pendingId) as { id: number } | undefined,
    events: sqlite.prepare(
      `SELECT stablecoin_id, symbol, peg_type, direction, peak_deviation_bps,
              started_at, start_price, peak_price, peg_reference, source,
              confirmation_sources, pending_reason
         FROM depeg_events WHERE stablecoin_id = ? ORDER BY id`,
    ).all(stablecoinId) as Array<Record<string, unknown>>,
    outcomes: sqlite.prepare(
      `SELECT pending_id, stablecoin_id, symbol, reason, first_seen_bps,
              peak_seen_bps, peak_price, peg_reference, outcome,
              confirming_sources, opposing_sources, unavailable_sources,
              circuit_open_sources, final_decision_reason
         FROM depeg_pending_outcomes WHERE pending_id = ? ORDER BY id`,
    ).all(pendingId) as Array<Record<string, unknown>>,
  };
}

async function settle(
  db: D1Database,
  plan: ConfirmationPlanReady,
  evidence: CollectedConfirmationEvidence,
): Promise<void> {
  const statements = evaluatePromotionDecision({ db, plan, evidence, now: NOW_SEC });
  if (statements.length > 0) await db.batch(statements);
}

afterEach(() => {
  for (const sqlite of openSqliteDatabases.splice(0)) sqlite.close();
});

describe("evaluatePromotionDecision", () => {
  it("promotes and persists complete event and outcome rows", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 100,
      first_seen_bps: -300,
      first_price: 0.97,
      peak_seen_bps: -300,
      peak_price: 0.97,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row,
      authoritativePrice: 0.95,
      primaryStatus: "confirm",
      primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
      temporalSameDirectionConfirmed: true,
    });
    const evidence = makeEvidence({
      confirmingSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
    });

    await settle(db, plan, evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.events).toEqual([{
      stablecoin_id: row.stablecoin_id,
      symbol: row.symbol,
      peg_type: row.peg_type,
      direction: row.direction,
      peak_deviation_bps: -500,
      started_at: row.first_seen_at,
      start_price: row.first_price,
      peak_price: 0.95,
      peg_reference: 1,
      source: "live",
      confirmation_sources: "temporal:15m+primary:oracle:pyth+primary:oracle:chainlink",
      pending_reason: "large-cap",
    }]);
    expect(state.outcomes).toEqual([{
      pending_id: row.id,
      stablecoin_id: row.stablecoin_id,
      symbol: row.symbol,
      reason: "large-cap",
      first_seen_bps: row.first_seen_bps,
      peak_seen_bps: row.peak_seen_bps,
      peak_price: row.peak_price,
      peg_reference: 1,
      outcome: "promoted",
      confirming_sources: "primary:oracle:pyth+primary:oracle:chainlink",
      opposing_sources: null,
      unavailable_sources: null,
      circuit_open_sources: null,
      final_decision_reason: "confirmed-by:temporal:15m+primary:oracle:pyth+primary:oracle:chainlink",
    }]);
  });

  it("promotes a refreshed pending row using the worst stored or confirmer peak state", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 101,
      peak_seen_bps: -400,
      peak_price: 0.96,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row,
      authoritativePrice: 0.97,
      primaryStatus: "confirm",
      primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
      temporalSameDirectionConfirmed: true,
    });
    const evidence = makeEvidence({
      confirmingSources: ["coingecko-confirm"],
      offchainStatus: "confirm",
      offchainSourceKey: "coingecko-confirm",
      offchainPeakCandidate: { bps: -600, price: 0.94 },
    });

    await settle(db, plan, evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.events[0]).toMatchObject({ peak_deviation_bps: -600, peak_price: 0.94 });
    expect(state.outcomes[0]).toMatchObject({
      outcome: "promoted",
      final_decision_reason: "confirmed-by:temporal:15m+primary:oracle:pyth+primary:oracle:chainlink+coingecko-confirm",
    });
  });

  it("rejects when authoritative primary remains depegged but two independent hard sources oppose", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 102 });
    insertPending(sqlite, row);
    const plan = makePlan({
      row,
      primaryStatus: "confirm",
      primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth"],
      temporalSameDirectionConfirmed: false,
    });
    const evidence = makeEvidence({
      cexStatus: "recover",
      poolStatus: "contradict",
      opposingSources: ["cex:binance", "pool:curve:curve"],
      hardOpposingSources: ["cex:binance", "pool:curve:curve"],
    });

    await settle(db, plan, evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.events).toEqual([]);
    expect(state.pending).toBeUndefined();
    expect(state.outcomes[0]).toMatchObject({
      outcome: "rejected",
      opposing_sources: "cex:binance+pool:curve:curve",
      final_decision_reason: "two-hard-opposing-sources:cex:binance+pool:curve:curve",
    });
  });

  it("rejects secondary evidence when the primary is not still depegged", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 103 });
    insertPending(sqlite, row);
    const plan = makePlan({ row });
    const evidence = makeEvidence({
      offchainStatus: "recover",
      opposingSources: ["coingecko-confirm"],
    });

    await settle(db, plan, evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.events).toEqual([]);
    expect(state.pending).toBeUndefined();
    expect(state.outcomes[0]).toMatchObject({
      outcome: "rejected",
      final_decision_reason: "secondary-evidence-opposes",
    });
  });

  it("keeps pending when evidence is mixed or insufficient", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 104 });
    insertPending(sqlite, row);

    await settle(db, makePlan({ row }), makeEvidence());

    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      pending: { id: row.id },
      events: [],
      outcomes: [],
    });
  });

  it("keeps expired-base pending rows when confirmation provider circuits are open", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 105 });
    insertPending(sqlite, row);
    const plan = makePlan({ row, age: DEPEG_PENDING_EXPIRY_SEC + 1 });
    const evidence = makeEvidence({
      unavailableSources: ["coingecko-confirm:upstream-error"],
      circuitOpenSources: ["cex:binance"],
    });

    await settle(db, plan, evidence);

    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      pending: { id: row.id },
      events: [],
      outcomes: [],
    });
  });

  it.each([
    {
      label: "expires a normal pending row after the final expiry limit",
      id: 106,
      reason: "large-cap",
      age: DEPEG_PENDING_EXPIRY_SEC + 1,
      expectedOutcome: "expired",
      expectedLimit: DEPEG_PENDING_EXPIRY_SEC,
    },
    {
      label: "records severe unconfirmed expiry after the extended severe limit",
      id: 107,
      reason: "extreme-move",
      age: DEPEG_PENDING_EXPIRY_SEC * 4 + 1,
      expectedOutcome: "unconfirmed-severe",
      expectedLimit: DEPEG_PENDING_EXPIRY_SEC * 4,
    },
  ])("$label", async ({ id, reason, age, expectedOutcome, expectedLimit }) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id, reason });
    insertPending(sqlite, row);

    await settle(db, makePlan({ row, age }), makeEvidence());

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.outcomes[0]).toMatchObject({
      outcome: expectedOutcome,
      final_decision_reason: `expired-after:${age}s;limit:${expectedLimit}s`,
    });
  });

  it("promotes a native-origin row after the native quote persists for the full window", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 109, first_seen_bps: -242, first_price: 0.9758, peak_seen_bps: -242, peak_price: 0.9758, peg_reference: 1, reason: "large-cap+native-origin" });
    insertPending(sqlite, row);
    await settle(db, makePlan({ row, authoritativePrice: 0.9758, primaryStatus: "confirm", primarySameDirectionDepegged: true, primaryConfirmationSources: ["primary:oracle:pyth"], temporalSameDirectionConfirmed: true }), makeEvidence());
    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.events[0]).toMatchObject({ peak_deviation_bps: -242, peak_price: 0.9758, confirmation_sources: "temporal:15m+primary:oracle:pyth", pending_reason: "large-cap+native-origin" });
    expect(state.outcomes[0]).toMatchObject({ outcome: "promoted", final_decision_reason: "confirmed-by:temporal:15m+primary:oracle:pyth" });
  });

  it("rejects the EURm native-origin spike when fresh independent USD/FX pricing remains at peg", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 110, stablecoin_id: "ceur-celo", symbol: "EURm", peg_type: "peggedEUR", direction: "above", first_seen_bps: 15_984, first_price: 2.598389348610164, peg_reference: 1, reason: "large-cap+native-origin" });
    insertPending(sqlite, row);
    const plan = makePlan({ row, primaryStatus: "recover", primarySameDirectionDepegged: false });
    const evidence = makeEvidence({ opposingSources: ["primary:defillama"] });
    await settle(db, plan, evidence);
    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.events).toEqual([]);
    expect(state.pending).toBeUndefined();
    expect(state.outcomes[0]).toMatchObject({ outcome: "rejected", opposing_sources: "primary:defillama", final_decision_reason: "secondary-evidence-opposes" });
  });

  it("does not promote a low-confidence pending event on circular off-chain agreement alone", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 108, reason: "low-confidence" });
    insertPending(sqlite, row);
    const plan = makePlan({ row });
    const evidence = makeEvidence({
      offchainStatus: "confirm",
      offchainSourceKey: "coingecko-confirm",
      offchainPeakCandidate: { bps: -500, price: 0.95 },
      confirmingSources: ["coingecko-confirm"],
    });

    await settle(db, plan, evidence);

    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      pending: { id: row.id },
      events: [],
      outcomes: [],
    });
  });
});

describe("evaluatePromotionDecision opposite-direction corroboration", () => {
  it.each([
    {
      id: 200,
      label: "native quote",
      evidence: makeEvidence({
        offchainStatus: "contradict",
        opposingSources: ["native:brl"],
        hardOpposingSources: ["native:brl"],
      }),
      expectedReject: true,
    },
    {
      id: 201,
      label: "off-chain quote",
      evidence: makeEvidence({
        offchainStatus: "contradict",
        opposingSources: ["coingecko-confirm"],
      }),
      expectedReject: true,
    },
    {
      id: 202,
      label: "DEX quote",
      evidence: makeEvidence(),
      expectedReject: false,
    },
    {
      id: 203,
      label: "CEX quote",
      evidence: makeEvidence({
        cexStatus: "contradict",
        opposingSources: ["cex:binance"],
        hardOpposingSources: ["cex:binance"],
      }),
      expectedReject: true,
    },
    {
      id: 204,
      label: "pool challenger",
      evidence: makeEvidence({
        poolStatus: "contradict",
        opposingSources: ["pool:curve:curve"],
        hardOpposingSources: ["pool:curve:curve"],
      }),
      expectedReject: true,
    },
  ])("does not promote opposite-direction corroboration from $label", async ({ id, evidence, expectedReject }) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id });
    insertPending(sqlite, row);

    await settle(db, makePlan({ row }), evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.events).toEqual([]);
    if (expectedReject) {
      expect(state.pending).toBeUndefined();
      expect(state.outcomes[0]).toMatchObject({
        outcome: "rejected",
        final_decision_reason: "secondary-evidence-opposes",
      });
    } else {
      expect(state.pending).toMatchObject({ id: row.id });
      expect(state.outcomes).toEqual([]);
    }
  });
});
