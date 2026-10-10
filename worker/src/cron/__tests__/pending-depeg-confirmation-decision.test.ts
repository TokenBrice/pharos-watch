import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  insertPendingDepeg,
  makePendingDepegRow,
} from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

import { normalizePendingDepegRow } from "../../lib/depeg-pending";
import { deriveDepegSignal } from "../../lib/depeg-signals";
import type {
  CollectedConfirmationEvidence,
  ConfirmationPlanReady,
} from "../pending-depeg-confirmation";
import { evaluatePromotionDecision } from "../pending-depeg-confirmation-decision";
import { collectConfirmationEvidence } from "../pending-depeg-confirmation-evidence";
import { emptyEvidence } from "./pending-depeg-confirmation.test-support";

const NOW_SEC = 1_700_000_000;
const sqliteFixtures = createLatestSchemaFixtureTracker();
const openFixture = sqliteFixtures.open;

const makePendingRow = (overrides: Partial<ReturnType<typeof makePendingDepegRow>> = {}) =>
  makePendingDepegRow(overrides, { firstSeenBps: -220, firstPrice: 0.978 });
const insertPending = insertPendingDepeg;


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
  sqliteFixtures.closeAll();
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
      offchainPeakCandidate: { bps: -600, price: 0.94, quoteDomain: "usd" },
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
      offchainPeakCandidate: { bps: -500, price: 0.95, quoteDomain: "usd" },
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
  it("collects fresh funded opposite-direction DEX evidence without promoting", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 202 });
    insertPending(sqlite, row);
    const plan = makePlan({ row });
    const evidence = await collectConfirmationEvidence({
      ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined, signal: undefined, cexAllowed: false, cexPrices: null,
      dexPriceRows: new Map([[row.stablecoin_id, { stablecoin_id: row.stablecoin_id, dex_price_usd: 1.05, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: NOW_SEC - 30 }]]),
      dexPriceSources: new Map([[row.stablecoin_id, [
        { protocol: "curve", sourceFamily: "curve", chain: "ethereum", price: 1.05, tvl: 3_000_000, updatedAt: NOW_SEC - 30 },
        { protocol: "uniswap", sourceFamily: "uniswap", chain: "ethereum", price: 1.04, tvl: 2_000_000, updatedAt: NOW_SEC - 30 },
      ]]]),
      poolChallengers: new Map(),
    });
    expect(evidence.dexConfirmationKeys).toEqual([]);
    expect(evidence.dexStatus).toBe("contradict");
    expect(evidence.unavailableSources).not.toContain("dex:aggregate-untrusted");
    await settle(db, plan, evidence);
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      events: [], pending: undefined,
      outcomes: [{ outcome: "rejected", final_decision_reason: "secondary-evidence-opposes" }],
    });
  });
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

describe("evaluatePromotionDecision promotion peak aggregation across channels", () => {
  it.each([
    { reason: "large-cap", candidateDomain: "native:peggedREAL" as const, reference: 0.2, price: 0.196 },
    { reason: "large-cap+native-origin", candidateDomain: "usd" as const, reference: 1, price: 0.98 },
    { reason: "large-cap+native-origin", candidateDomain: "native:peggedEUR" as const, reference: 1, price: 0.98 },
  ])("leaves incomparable $candidateDomain peaks out of a $reason event", async ({ reason, candidateDomain, reference, price }) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 305, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL",
      reason, peg_reference: reference, first_seen_bps: -200, first_price: price,
      last_seen_bps: -200, last_price: price, peak_seen_bps: -200, peak_price: price,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, pegReference: reference, authoritativePrice: price,
      primaryStatus: "confirm", primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
      temporalSameDirectionConfirmed: true,
    });
    await settle(db, plan, makeEvidence({
      offchainStatus: "confirm", offchainSourceKey: "native:eur",
      offchainPeakCandidate: { bps: -900, price: 0.91, quoteDomain: candidateDomain },
    }));
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).events[0]).toMatchObject({
      peak_deviation_bps: -200, peak_price: price, peg_reference: reference,
    });
  });

  it.each([
    { currency: "EUR", reference: 1.1 },
    { currency: "BRL", reference: 0.193 },
  ])("normalizes a $currency native confirmer peak into a USD-origin event", async ({ currency, reference }) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 300, stablecoin_id: "non-usd-coin", symbol: currency,
      peg_type: currency === "EUR" ? "peggedEUR" : "peggedREAL",
      peg_reference: reference, first_seen_bps: -200, first_price: reference * 0.98,
      last_seen_bps: -200, last_price: reference * 0.98,
      peak_seen_bps: -200, peak_price: reference * 0.98,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, pegReference: reference, authoritativePrice: reference * 0.98,
      primaryStatus: "confirm", primarySameDirectionDepegged: true,
      temporalSameDirectionConfirmed: true, nativeSourceKey: `native:${currency.toLowerCase()}`,
      nativeSignal: deriveDepegSignal(0.94, 1),
      nativePegQuote: { stablecoinId: row.stablecoin_id, geckoId: "non-usd-coin", pegCurrency: currency, price: 0.94, updatedAt: NOW_SEC - 30 },
    });
    const evidence = await collectConfirmationEvidence({
      ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined,
      signal: undefined, cexAllowed: false, cexPrices: null,
      dexPriceRows: new Map(), dexPriceSources: new Map(), poolChallengers: new Map(),
    });
    expect(evidence.offchainPeakCandidate?.price).toBeCloseTo(reference * 0.94, 10);
    await settle(db, plan, evidence);
    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.events[0]).toMatchObject({
      start_price: reference * 0.98, peg_reference: reference, peak_deviation_bps: -600,
    });
    expect(Number(state.events[0].peak_price)).toBeCloseTo(reference * 0.94, 10);
    expect((Number(state.events[0].peak_price) / reference - 1) * 10_000).toBeCloseTo(-600, 6);
    expect(state.events[0].confirmation_sources).toBe(`temporal:15m+native:${currency.toLowerCase()}`);
  });

  it("retains native prices and reference for a native-origin promotion", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 301, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL",
      reason: "large-cap+native-origin", peg_reference: 1,
      first_seen_bps: -200, first_price: 0.98, peak_seen_bps: -200, peak_price: 0.98,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, authoritativePrice: 0.94, primaryStatus: "confirm", primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth"], temporalSameDirectionConfirmed: true,
    });
    const evidence = await collectConfirmationEvidence({
      ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined,
      signal: undefined, cexAllowed: false, cexPrices: null,
      dexPriceRows: new Map(), dexPriceSources: new Map(), poolChallengers: new Map(),
    });
    await settle(db, plan, evidence);
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).events[0])
      .toMatchObject({ start_price: 0.98, peak_price: 0.94, peg_reference: 1, peak_deviation_bps: -600 });
  });

  it.each([1, 2])("admits pool peaks only after %s confirming groups pass the opposing vote", async (confirmingCount) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 302, first_seen_bps: -200, first_price: 0.98, last_seen_bps: -200,
      last_price: 0.98, peak_seen_bps: -200, peak_price: 0.98,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, authoritativePrice: 0.98, primaryStatus: "confirm", primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
      temporalSameDirectionConfirmed: true,
    });
    const evidence = await collectConfirmationEvidence({
      ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined,
      signal: undefined, cexAllowed: false, cexPrices: null,
      dexPriceRows: new Map(), dexPriceSources: new Map(),
      poolChallengers: new Map([[row.stablecoin_id, [
        ...["curve", "uniswap"].slice(0, confirmingCount).map((protocol) => ({
          price: 0.8, tvlUsd: 1_000_000, protocol, sourceFamily: protocol, chain: "ethereum",
        })),
        ...["aerodrome", "balancer"].map((protocol) => ({
          price: 1, tvlUsd: 1_000_000, protocol, sourceFamily: protocol, chain: "ethereum",
        })),
      ]]]),
    });
    expect(evidence.poolStatus).toBe(confirmingCount === 1 ? "insufficient" : "confirm");
    expect(evidence.poolConfirmations).toHaveLength(confirmingCount === 1 ? 0 : 2);
    await settle(db, plan, evidence);
    const event = readLifecycle(sqlite, row.stablecoin_id, row.id).events[0];
    expect(event).toMatchObject({
      peak_deviation_bps: confirmingCount === 1 ? -200 : -2000,
      peak_price: confirmingCount === 1 ? 0.98 : 0.8,
    });
    expect(event.confirmation_sources).toBe("temporal:15m+primary:oracle:pyth+primary:oracle:chainlink" +
      (confirmingCount === 1 ? "" : "+pool:curve:curve+pool:uniswap:uniswap"));
  });

  it("ignores unadmitted pool candidates even when another source promotes", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 303, first_seen_bps: -200, first_price: 0.98, peak_seen_bps: -200, peak_price: 0.98 });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, authoritativePrice: 0.98, primaryStatus: "confirm", primarySameDirectionDepegged: true,
      primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"],
      temporalSameDirectionConfirmed: true,
    });
    const evidence = makeEvidence({
      poolStatus: "insufficient", poolConfirmations: [{
        key: "curve:curve", pool: { price: 0.8, tvlUsd: 1_000_000, protocol: "curve", sourceFamily: "curve" },
        signal: deriveDepegSignal(0.8, 1)!,
      }],
    });
    await settle(db, plan, evidence);
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).events[0]).toMatchObject({
      peak_deviation_bps: -200, peak_price: 0.98,
      confirmation_sources: "temporal:15m+primary:oracle:pyth+primary:oracle:chainlink",
    });
  });

  it.each([
    { opposingCount: 0, opposingPrice: 1 },
    { opposingCount: 1, opposingPrice: 1 },
    { opposingCount: 2, opposingPrice: 1 },
    { opposingCount: 2, opposingPrice: 1.02 },
  ])("requires the high-TVL pool vote with $opposingCount opposing groups at $opposingPrice before pool-only promotion", async ({ opposingCount, opposingPrice }) => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 304 });
    insertPending(sqlite, row);
    const plan = makePlan({
      row, authoritativePrice: 0.98, primaryStatus: "confirm", primarySameDirectionDepegged: true,
      temporalSameDirectionConfirmed: true,
    });
    const evidence = await collectConfirmationEvidence({
      ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined,
      signal: undefined, cexAllowed: false, cexPrices: null,
      dexPriceRows: new Map(), dexPriceSources: new Map(),
      poolChallengers: new Map([[row.stablecoin_id, [
        { price: 0.8, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
        ...["uniswap", "aerodrome"].slice(0, opposingCount).map((protocol) => ({
          price: opposingPrice, tvlUsd: 6_000_000, protocol, sourceFamily: protocol, chain: "ethereum",
        })),
      ]]]),
    });
    await settle(db, plan, evidence);
    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    if (opposingCount <= 1) {
      expect(state.pending).toBeUndefined();
      expect(state.events[0]).toMatchObject({ peak_deviation_bps: -2000, peak_price: 0.8, confirmation_sources: "temporal:15m+pool:curve:curve" });
      expect(state.outcomes[0]).toMatchObject({ outcome: "promoted" });
    } else {
      expect(state).toMatchObject({ pending: { id: row.id }, events: [], outcomes: [] });
      expect(evidence.confirmingSources).toEqual([]);
    }
  });

  it("promotes with the deepest CEX peak candidate and credits confirmed pools in the event record", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 205, peak_seen_bps: -300, peak_price: 0.97 });
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
      cexStatus: "confirm",
      cexPeakCandidate: { bps: -700, price: 0.93, quoteDomain: "usd" },
      poolStatus: "confirm",
      poolConfirmations: [{
        key: "curve:curve",
        pool: { price: 0.94, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum" },
        signal: deriveDepegSignal(0.94, 1)!,
      }],
    });

    await settle(db, plan, evidence);

    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.events[0]).toMatchObject({
      peak_deviation_bps: -700,
      peak_price: 0.93,
      confirmation_sources: "temporal:15m+primary:oracle:pyth+primary:oracle:chainlink+cex:binance+pool:curve:curve",
    });
    expect(state.outcomes[0]).toMatchObject({
      outcome: "promoted",
      final_decision_reason: "confirmed-by:temporal:15m+primary:oracle:pyth+primary:oracle:chainlink+cex:binance+pool:curve:curve",
    });
  });
});
