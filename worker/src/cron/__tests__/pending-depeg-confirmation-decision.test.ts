import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  insertPendingDepeg,
  makePendingDepegRow,
} from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { createLatestSchemaFixtureTracker } from "@shared/test-utils/latest-schema-sqlite";

import { buildUpsertPendingDepegStmt, normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import { deriveDepegSignal } from "@shared/lib/depeg-signals";
import type {
  CollectedConfirmationEvidence,
  ConfirmationPlanReady,
  ConfirmationEvidenceInput,
  ConfirmationPlanInput,
} from "../pending-depeg-confirmation";
import { buildConfirmationPlan } from "../pending-depeg-confirmation";
import { hydrateDepegDetection } from "../depeg-detection/hydration";
import { attachDetectionReferenceContext } from "../depeg-detection/reference-policy";
import { persistDepegCommands } from "../depeg-detection/persistence";
import { decideDepegAsset } from "../depeg-detection/decision-engine";
import { referenceState, tradedPair } from "../depeg-detection/__tests__/reference-fixtures";
import { rowToDepegEvent, type DepegRow } from "../../lib/depeg-helpers";
import { admittedDepegOnset } from "../../lib/tape-projectors/depeg";
import { projectDepegPeakBasis } from "../telegram/sources/telegram-alert-snapshots";
import { ACTIVE_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { evaluatePromotionDecision } from "../pending-depeg-confirmation-decision";
import { collectConfirmationEvidence } from "../pending-depeg-confirmation-evidence";
import { emptyEvidence } from "./pending-depeg-confirmation.test-support";

const NOW_SEC = 1_700_000_000;
const primaryAgreement = {
  primaryStatus: "confirm" as const, primarySameDirectionDepegged: true,
  primaryConfirmationSources: ["primary:oracle:pyth", "primary:oracle:chainlink"], temporalSameDirectionConfirmed: true,
};
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
    nativeQuoteImplausibility: null,
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

function collectPlanEvidence(db: D1Database, plan: ConfirmationPlanReady, overrides: Partial<ConfirmationEvidenceInput> = {}) {
  return collectConfirmationEvidence({
    ...plan, db, now: NOW_SEC, coingeckoAllowed: false, coingeckoApiKey: undefined, signal: undefined,
    cexAllowed: false, cexPrices: null, dexPriceRows: new Map(), dexPriceSources: new Map(),
    poolChallengers: new Map(), ...overrides,
  });
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
  now = NOW_SEC,
): Promise<void> {
  const statements = evaluatePromotionDecision({ db, plan, evidence, now });
  if (statements.length > 0) await db.batch(statements);
}

const eurc = ACTIVE_META_BY_ID.get("eurc-circle")!;
const eurcAsset = (now: number, overrides: Parameters<typeof makeAsset>[0]) => makeAsset({
  id: eurc.id, pegType: "peggedEUR", priceObservedAt: now - 30, priceObservedAtMode: "upstream", ...overrides,
});
const eurcInputs = (now: number, asset: ReturnType<typeof makeAsset>, pegRates = { peggedEUR: 1.1 }) => ({
  now, asset, meta: eurc, pegRates, pegRateSources: { peggedEUR: "fx" as const }, pegRateCounts: {},
});
const eurcQuote = (price: number, updatedAt: number, venue?: string) => ({
  stablecoinId: eurc.id, geckoId: eurc.geckoId!, pegCurrency: "EUR", price, updatedAt,
  derivation: venue ? { ...tradedPair, lineage: { venue, pair: "EURC/EUR" } } : tradedPair,
});
const eurcPool = (price: number, observedAt: number, tvlUsd = 6e6) => ({
  price, observedAt, tvlUsd, protocol: "curve", sourceFamily: "curve", chain: "ethereum",
});
const readPending = (sqlite: DatabaseSync) =>
  sqlite.prepare("SELECT * FROM depeg_pending").get() as unknown as PendingDepegRow;

function attachFx(rates: Record<string, number>, observedAt: number) {
  const fx = referenceState(rates, observedAt);
  return attachDetectionReferenceContext(rates, [], new Map(), new Set(), fx, fx.repricingByPeg);
}

function planFor(
  db: D1Database,
  row: PendingDepegRow,
  input: ReturnType<typeof eurcInputs> & Partial<Pick<ConfirmationPlanInput, "nativePegQuote" | "challengerPools">>,
) {
  return buildConfirmationPlan({ db, row, pendingState: normalizePendingDepegRow(row),
    openSet: new Set(), nativePegQuote: undefined, ...input });
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
      ...primaryAgreement,
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
      ...primaryAgreement,
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
    expect(state.outcomes[0]).toMatchObject({
      outcome: "promoted",
      confirming_sources: "primary:oracle:pyth",
      final_decision_reason: "confirmed-by:temporal:15m+primary:oracle:pyth",
    });
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

describe("evaluatePromotionDecision native quote plausibility bound", () => {
  it("withholds an implausible above-peg native sample instead of confirming the cEUR unit error", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 111,
      stablecoin_id: "ceur-celo",
      symbol: "EURm",
      peg_type: "peggedEUR",
      direction: "above",
      first_seen_bps: 15_984,
      first_price: 2.598389348610164,
      last_seen_bps: 15_984,
      last_price: 2.598389348610164,
      peak_seen_bps: 15_984,
      peak_price: 2.598389348610164,
      peg_reference: 1,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row,
      asset: makeAsset({ id: row.stablecoin_id, symbol: row.symbol, geckoId: "celo-euro", price: 1.16 }),
      pegReference: 1,
      authoritativePrice: 1.16,
      nativeSignal: deriveDepegSignal(2.598389348610164, 1),
      nativePegQuote: {
        stablecoinId: row.stablecoin_id,
        geckoId: "celo-euro",
        pegCurrency: "EUR",
        price: 2.598389348610164,
        updatedAt: NOW_SEC - 30, derivation: tradedPair,
      },
      nativeSourceKey: "native:eur",
      temporalSameDirectionConfirmed: true,
    });

    const evidence = await collectPlanEvidence(db, plan);

    expect(evidence.offchainStatus).toBe("insufficient");
    expect(evidence.offchainPeakCandidate).toBeNull();
    expect(evidence.confirmingSources).not.toContain("native:eur");
    expect(evidence.unavailableSources).toContain("native:eur:native-quote-above-peg-reference-band");

    await settle(db, plan, evidence);

    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      pending: { id: row.id },
      events: [],
      outcomes: [],
    });
  });

  it("does not let an implausible native quote reject a pending depeg", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({
      id: 112,
      stablecoin_id: "ceur-celo",
      symbol: "EURm",
      peg_type: "peggedEUR",
      direction: "above",
      first_seen_bps: 300,
      first_price: 1.03,
      last_seen_bps: 300,
      last_price: 1.03,
      peg_reference: 1,
    });
    insertPending(sqlite, row);
    const plan = makePlan({
      row,
      asset: makeAsset({ id: row.stablecoin_id, symbol: row.symbol, geckoId: "celo-euro", price: 1.16 }),
      pegReference: 1,
      authoritativePrice: 1.16,
      nativeSignal: deriveDepegSignal(0.2, 1),
      nativePegQuote: {
        stablecoinId: row.stablecoin_id,
        geckoId: "celo-euro",
        pegCurrency: "EUR",
        price: 0.2,
        updatedAt: NOW_SEC - 30, derivation: tradedPair,
      },
      nativeSourceKey: "native:eur",
      temporalSameDirectionConfirmed: true,
    });

    const evidence = await collectPlanEvidence(db, plan);

    expect(evidence.offchainStatus).toBe("insufficient");
    expect(evidence.offchainPeakCandidate).toBeNull();
    expect(evidence.opposingSources).not.toContain("native:eur");
    expect(evidence.hardOpposingSources).not.toContain("native:eur");
    expect(evidence.unavailableSources).toContain("native:eur:native-quote-extreme-move");

    await settle(db, plan, evidence);

    expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
      pending: { id: row.id },
      events: [],
      outcomes: [],
    });
  });
});

describe("evaluatePromotionDecision opposite-direction corroboration", () => {
  it.each(["offchain", "cex"])("vetoes %s rejection with stale DEX", async (opponent) => {
    for (const aggregateObservedAt of [null, NOW_SEC - 4500, NOW_SEC - 21_600]) {
      const { sqlite, db } = openFixture();
      const row = makePendingRow({ id: 206 });
      insertPending(sqlite, row);
      const plan = makePlan({ row, temporalSameDirectionConfirmed: true, evidence: opponent === "offchain"
        ? makeEvidence({ offchainStatus: "contradict", opposingSources: ["coingecko-confirm"] }) : emptyEvidence() });
      const evidence = await collectPlanEvidence(db, plan, {
        cexAllowed: opponent === "cex", cexPrices: new Map([[row.symbol, 1.05]]),
        dexPriceRows: new Map([[row.stablecoin_id, { stablecoin_id: row.stablecoin_id, dex_price_usd: 0.95,
          deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000,
          updated_at: NOW_SEC - 30, aggregateObservedAt }]]),
        dexPriceSources: new Map([[row.stablecoin_id, ["curve", "uniswap"].map((protocol) => ({
          protocol, sourceFamily: protocol, chain: "ethereum", price: 0.95, tvl: 2_500_000, updatedAt: NOW_SEC - 30,
        }))]]),
      });
      expect(evidence).toMatchObject({ dexStatus: "insufficient", dexConfirmationVeto: true,
        dexConfirmationKeys: [], dexPeakCandidates: [], confirmingSources: [] });
      await settle(db, plan, evidence);
      expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({ pending: { id: row.id }, events: [], outcomes: [] });
    }
  });

  it.each(["intermediate-native", "aggregate-veto"] as const)("retains available EURC evidence for %s", async (scenario) => {
    const { db, sqlite } = openFixture();
    const closed = scenario === "intermediate-native";
    const now = (closed ? Date.UTC(2026, 10, 13, 22, 20) : Date.UTC(2026, 10, 12, 12)) / 1_000;
    const price = closed ? 0.8195 : 1.045;
    const bps = closed ? -2550 : -500;
    const row = makePendingRow({ stablecoin_id: eurc.id, symbol: eurc.symbol, peg_type: "peggedEUR",
      first_seen_at: now - 1_000, last_seen_at: now - 30, peg_reference: 1.10,
      first_price: price, last_price: price, first_seen_bps: bps, last_seen_bps: bps });
    insertPending(sqlite, row);
    const input = eurcInputs(now, eurcAsset(now, { price, priceSource: closed ? "pyth" : "defillama" }));
    attachFx(input.pegRates, closed ? Date.UTC(2026, 10, 13, 21, 55) / 1_000 : now - 60);
    const plan = planFor(db, row, { ...input, nativePegQuote: closed ? eurcQuote(0.755, now - 60) : undefined });
    if (plan.kind !== "ready") throw new Error("Expected to evaluate other evidence");
    const pools = (closed ? ["curve"] : ["sushiswap", "aerodrome"]).map((protocol) => ({
      protocol, sourceFamily: protocol, chain: "ethereum", price: closed ? 0.81 : 1.10, tvlUsd: 6_000_000, observedAt: now - 30 }));
    const evidence = await collectPlanEvidence(db, plan, { now, poolChallengers: new Map([[eurc.id, pools]]),
      ...(closed ? {} : {
        dexPriceRows: new Map([[eurc.id, { stablecoin_id: eurc.id, dex_price_usd: price, aggregateObservedAt: null,
          deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 12_000_000, updated_at: now - 30 }]]),
        dexPriceSources: new Map([[eurc.id, ["curve", "uniswap"].map((protocol) => ({
          protocol, sourceFamily: protocol, chain: "ethereum", price, tvl: 6_000_000, updatedAt: now - 30, observedAt: now - 30 }))]]),
      }) });
    expect(evidence).toMatchObject({ poolStatus: closed ? "confirm" : "recover", dexPeakCandidates: [] });
    if (!closed) expect(evidence.dexConfirmationVeto).toBe(true);
    await settle(db, plan, evidence, now);
    const state = readLifecycle(sqlite, eurc.id, row.id);
    expect(state.events).toHaveLength(closed ? 1 : 0);
    if (!closed) expect(state.pending).toEqual({ id: row.id });
  });

  it("collects fresh funded opposite-direction DEX evidence without promoting", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ id: 202 });
    insertPending(sqlite, row);
    const plan = makePlan({ row });
    const evidence = await collectPlanEvidence(db, plan, {
      dexPriceRows: new Map([[row.stablecoin_id, { stablecoin_id: row.stablecoin_id, dex_price_usd: 1.05, deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 5_000_000, updated_at: NOW_SEC - 30, aggregateObservedAt: NOW_SEC - 30 }]]),
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
      ...primaryAgreement,
    });
    await settle(db, plan, makeEvidence({
      offchainStatus: "confirm", offchainSourceKey: "native:eur",
      offchainPeakCandidate: { bps: -900, price: 0.91, quoteDomain: candidateDomain },
    }));
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).events[0]).toMatchObject({
      peak_deviation_bps: -200, peak_price: price, peg_reference: reference,
    });
  });

  it("retains the observed DEX price when pending and DEX round to the same display peak", async () => {
    const { sqlite, db } = openFixture();
    const row = makePendingRow({ first_price: 0.97999, first_seen_bps: -200.1, last_price: 0.97999,
      last_seen_bps: -200.1, peak_price: 0.97999, peak_seen_bps: -200.1, peg_reference: 1 });
    insertPending(sqlite, row);
    const plan = makePlan({ row, authoritativePrice: 0.97999, ...primaryAgreement });
    const dexPrice = 0.97996;
    const evidence = await collectPlanEvidence(db, plan, {
      dexPriceRows: new Map([[row.stablecoin_id, { stablecoin_id: row.stablecoin_id, dex_price_usd: dexPrice,
        deviation_from_primary_bps: null, source_pool_count: 2, source_total_tvl: 6_000_000,
        updated_at: NOW_SEC - 30, aggregateObservedAt: NOW_SEC - 45 }]]),
      dexPriceSources: new Map([[row.stablecoin_id, ["curve", "uniswap"].map((protocol) => ({
        protocol, sourceFamily: protocol, chain: "ethereum", price: dexPrice, tvl: 3_000_000,
        updatedAt: NOW_SEC - 30, observedAt: NOW_SEC - 45,
      }))]]),
    });
    await settle(db, plan, evidence);
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).events[0]).toMatchObject({ peak_deviation_bps: -200, peak_price: dexPrice });
  });

  it("keeps a continuous pre-close onset and reloads the promoted peer-relative basis", async () => {
    const { db, sqlite } = openFixture();
    const now = Date.UTC(2026, 10, 13, 22, 10) / 1_000;
    const pegType = "peggedEUR";
    const startAt = now - 1_000;
    const pending = { stablecoinId: eurc.id, symbol: eurc.symbol, pegType, direction: "below" as const, bps: -300,
      seenAt: startAt, price: 1.067, pegReference: 1.10, reason: "confirmation-window" };
    await buildUpsertPendingDepegStmt(db, pending).run();
    const sample = (id: string, priceSource: string, price: number) => eurcAsset(now, {
      id, priceSource, price, circulating: { ethereum: 5e6 },
    });
    const asset = sample(eurc.id, "defillama", 1.02);
    const peers = ["coinbase", "binance", "kraken"].map((venue) => sample(venue, venue, 1.10));
    const peerMeta = new Map([asset, ...peers].map((coin) => [coin.id, eurc]));
    const challengerPools = [eurcPool(1.02, now - 30, 5e5)];
    const inputs = { ...eurcInputs(now, asset), challengerPools };
    const context = attachDetectionReferenceContext(inputs.pegRates, [asset, ...peers], peerMeta, new Set(), null);
    const planPending = () => planFor(db, readPending(sqlite), inputs);
    expect(decideDepegAsset(inputs).commands).toEqual([]);
    expect(planPending().kind).toBe("wait");
    context.rollbackSupportsPeerEvents = true;
    expect(planPending()).toMatchObject({ kind: "ready", independentConfirmation: { source: "pool:curve:curve" } });
    expect(decideDepegAsset({ ...inputs, existing: {
      id: 42, stablecoin_id: eurc.id, symbol: eurc.symbol, peg_type: pegType, direction: "below", source: "live",
      started_at: startAt, ended_at: null, start_price: 1.0725, peak_price: 1.0725, peak_deviation_bps: -250,
      recovery_price: null, peg_reference: 1.10, confirmation_sources: null, pending_reason: "confirmation-window",
    } }).commands).toMatchObject([{ type: "update-peak", peakDeviationBps: -727, peakPegReference: 1.10 }]);
    const command = decideDepegAsset(inputs).commands[0];
    if (command?.type !== "upsert-pending") throw new Error("Expected compatible peer observation");
    await buildUpsertPendingDepegStmt(db, command.payload).run();
    const row = readPending(sqlite);
    expect(row.first_seen_at).toBe(startAt);
    expect(JSON.parse(row.peer_basis_json!)).toMatchObject({ onset: { basis: "benchmark" }, latest: { basis: "peer-relative" } });
    const plan = planFor(db, row, inputs);
    if (plan.kind !== "ready") throw new Error("Expected peer promotion");
    await settle(db, plan, plan.evidence, now);
    const { openRows: [existing] } = await hydrateDepegDetection(db, []);
    expect(existing.pending_reason).toContain("peer-relative");
    const worsened = decideDepegAsset({ ...inputs, now: now + 60, existing, asset: { ...asset, price: 1.01, priceObservedAt: now + 30 },
      challengerPools: [{ ...challengerPools[0], price: 1.01, observedAt: now + 30 }] });
    expect(worsened.commands).toMatchObject([{ type: "update-peak", peakPegReference: 1.10 }]);
    await persistDepegCommands(db, worsened.commands);
    const { openRows: [updated] } = await hydrateDepegDetection(db, []);
    expect(projectDepegPeakBasis(updated)).toEqual({ peakBasis: "peer-relative" });
    expect(JSON.parse(updated.peer_basis_json!)).toMatchObject({ onset: { basis: "benchmark" },
      peak: { basis: "peer-relative", observedAt: now + 30, price: 1.01,
        corroboration: { confidence: "low", corroborator: { source: "pool:curve:curve" } } } });
  });

  it.each([false, true])("handles a stored peer onset when rollback support is %s and the benchmark reopens", async (supported) => {
    const { db, sqlite } = openFixture();
    const now = Date.UTC(2026, 10, 15, 23, 10) / 1_000;
    const startAt = now - 1_000;
    const pending = { stablecoinId: eurc.id, symbol: eurc.symbol, pegType: "peggedEUR", direction: "below" as const,
      bps: -400, seenAt: startAt, price: 1.056, pegReference: 1.10, reason: "confirmation-window+low-confidence+peer-relative",
      peerBasis: JSON.stringify({ confidence: "low", contributors: [{ id: "peer", provenanceKey: "coinbase" }] }) };
    await buildUpsertPendingDepegStmt(db, pending).run();
    await buildUpsertPendingDepegStmt(db, { ...pending, seenAt: now - 30, bps: -250, price: 1.092,
      pegReference: 1.12, reason: "confirmation-window", peerBasis: undefined }).run();
    const row = readPending(sqlite);
    const input = eurcInputs(now, eurcAsset(now, {
      price: 1.092, priceSource: "pyth+chainlink", agreeSources: ["pyth", "chainlink"],
      priceConfidence: "high", priceObservedAt: now - 45,
    }), { peggedEUR: 1.12 });
    attachFx(input.pegRates, now - 60).rollbackSupportsPeerEvents = supported;
    const plan = planFor(db, row, input);
    if (!supported) {
      if (plan.kind !== "mutate") throw new Error("Expected rejection of the stored peer onset");
      await db.batch(plan.statements);
      expect(readLifecycle(sqlite, row.stablecoin_id, row.id)).toMatchObject({
        events: [], pending: undefined, outcomes: [{ outcome: "rejected", final_decision_reason: "peer-event-rollback-incompatible" }],
      });
      return;
    }
    if (plan.kind !== "ready") throw new Error("Expected benchmark admission after reopening");
    await settle(db, plan, plan.evidence, now);
    const { openRows: [existing] } = await hydrateDepegDetection(db, []);
    expect(existing).toMatchObject({ started_at: startAt, pending_reason: "confirmation-window+low-confidence+peer-relative",
      peak_price: 1.056, peak_peg_reference: 1.10, last_trusted_price_at: now - 45 });
    expect(admittedDepegOnset(existing)).toBe(startAt);
    expect(JSON.parse(existing.peer_basis_json!)).toMatchObject({
      onset: { basis: "peer-relative", corroboration: { confidence: "low" } },
      peak: { basis: "peer-relative", pegReference: 1.10, corroboration: { contributors: [{ id: "peer" }] } },
    });
  });

  it.each([
    { onsite: "coinbase", second: "coinbase", price: 0.40, weekend: false, promotes: false },
    { onsite: "coinbase", second: "coinbase", price: 0.90, weekend: true, promotes: false },
    { onsite: "coinbase", second: "kraken", price: 0.90, weekend: true, promotes: true },
    { onsite: "coinbase", second: "kraken", price: 0.40, weekend: true, promotes: true },
    { onsite: undefined, second: "kraken", price: 0.90, weekend: true, promotes: false },
  ])("requires an independent native venue for $onsite/$second at $price", async ({ onsite, second, price, weekend, promotes }) => {
    const { db, sqlite } = openFixture();
    const now = Date.UTC(2026, 10, weekend ? 14 : 12, 12) / 1_000;
    const p = { stablecoinId: eurc.id, symbol: eurc.symbol, pegType: "peggedEUR", direction: "below" as const, bps: (price - 1) * 10_000,
      price, pegReference: 1, reason: "confirmation-window+native-origin", nativeVenue: onsite };
    await buildUpsertPendingDepegStmt(db, { ...p, seenAt: now - 1_000 }).run();
    await buildUpsertPendingDepegStmt(db, { ...p, seenAt: now - 60 }).run();
    const row = readPending(sqlite);
    const input = eurcInputs(now, eurcAsset(now, {
      price: price * 1.10, priceSource: "coinbase", agreeSources: ["coinbase"],
      priceConfidence: "single-source", priceObservedAt: now - 45,
    }));
    attachFx(input.pegRates, now - 60);
    const plan = planFor(db, row, { ...input, nativePegQuote: eurcQuote(price, now - 60, second) });
    if (plan.kind !== "ready") throw new Error("Expected a candidate ready to assess its evidence");
    await settle(db, plan, plan.evidence, now);
    const state = readLifecycle(sqlite, eurc.id, row.id);
    expect(state.events).toHaveLength(promotes ? 1 : 0);
    if (promotes) {
      expect(state.events[0].confirmation_sources).toBe("temporal:15m+native:eur");
      const receipt = sqlite.prepare("SELECT peer_basis_json AS receipt FROM depeg_events").get() as { receipt: string };
      expect(JSON.parse(receipt.receipt).confirmation).toMatchObject({ venue: second, observedAt: now - 60, price });
      expect(sqlite.prepare("SELECT last_trusted_price_at FROM depeg_events").get()).toEqual({ last_trusted_price_at: now - 60 });
    }
  });

  it.each(["distinct-extremes", "same-venue-extreme", "cohort-drift", "retained-peer"] as const)(
    "runs detection and confirmation together for %s", async (scenario) => {
      const { db, sqlite } = openFixture();
      const now = (scenario === "cohort-drift" ? Date.UTC(2026, 10, 13, 22, 30)
        : Date.UTC(2026, 10, scenario === "same-venue-extreme" ? 12 : 14, 12)) / 1_000;
      const sharedMove = scenario === "cohort-drift";
      const retained = scenario === "retained-peer";
      const hasPeers = sharedMove || retained;
      const open = scenario === "same-venue-extreme";
      const pegRates = { peggedEUR: sharedMove ? 1 : 1.1 };
      const inputAt = (at: number, first: boolean) => {
        const price = sharedMove ? 0.74 : retained ? (first ? 1.10 : 1.02) : open ? (first ? 1.10 : 0.44) : 1.10;
        const priceSource = open ? "coinbase" : "coingecko";
        const asset = eurcAsset(at, { price, priceSource, agreeSources: [priceSource], priceObservedAt: at, priceUpdatedAt: at });
        const peers = hasPeers && (!retained || !first) ? ["kraken", "coinbase", "binance"].map((venue) => ({
          ...asset, id: venue, price: sharedMove ? 0.74 : 1.10, priceSource: venue, agreeSources: [venue],
        })) : [];
        const fx = referenceState(pegRates, open ? at - 30 : Date.UTC(2026, 10, 13, 21, 55) / 1_000);
        attachDetectionReferenceContext(pegRates, [asset, ...peers], new Map([asset, ...peers].map((item) => [item.id, eurc])),
          new Set(), fx, fx.repricingByPeg);
        const nativePrice = sharedMove || (open && first) ? 0.98 : retained ? 0.93 : 0.40;
        const venue = first ? (open ? "kraken" : "bitso") : open ? "coinbase" : scenario === "distinct-extremes" ? "kraken" : "bitso";
        return { ...eurcInputs(at, asset, pegRates),
          challengerPools: hasPeers && !first ? [eurcPool(sharedMove ? 0.73 : 1.02, at)] : [],
          nativePegQuote: eurcQuote(nativePrice, at, venue),
        };
      };
      const first = inputAt(now - 900, true);
      const initial = decideDepegAsset(first);
      expect(initial.commands).toMatchObject([{ type: "upsert-pending", payload: {
        price: first.nativePegQuote.price, pegReference: 1, nativeVenue: first.nativePegQuote.derivation.lineage?.venue,
      } }]);
      await persistDepegCommands(db, initial.commands);
      const next = inputAt(now, false);
      if (retained) {
        // A repeated native trade was retained before the independent pool/peer quorum became available.
        const repeat = decideDepegAsset({ ...first, now, nativePegQuote: { ...first.nativePegQuote, updatedAt: now } });
        await persistDepegCommands(db, repeat.commands);
      } else if (!open) {
        await persistDepegCommands(db, decideDepegAsset(next).commands);
      }
      const row = readPending(sqlite);
      const plan = planFor(db, row, { ...next, nativePegQuote: retained ? undefined : next.nativePegQuote });
      expect(plan.kind).toBe("ready");
      if (plan.kind !== "ready") return;
      if (sharedMove) {
        expect(plan.allowsUsdObservation?.(0.73, now)).toBe(false);
        expect(plan.independentConfirmation).toBeUndefined();
      }
      await settle(db, plan, plan.evidence, now);
      const state = readLifecycle(sqlite, eurc.id, row.id);
      if (scenario === "distinct-extremes" || retained) {
        expect(state.events[0]).toMatchObject({ peak_price: retained ? 0.93 : 0.40, peg_reference: 1,
          confirmation_sources: retained ? "temporal:15m+peer:median" : "temporal:15m+native:eur" });
      } else expect(state.events).toEqual([]);
    },
  );

  it("expires an old peer-relative candidate after reopening when its quorum vanishes", async () => {
    const { db, sqlite } = openFixture();
    const now = Date.UTC(2026, 10, 16, 12) / 1_000;
    const row = makePendingRow({ stablecoin_id: eurc.id, peg_type: "peggedEUR",
      first_seen_at: now - 172_800, last_seen_at: now - 172_500, reason: "confirmation-window+low-confidence+peer-relative",
      peg_reference: 1.10 });
    insertPending(sqlite, row);
    const input = eurcInputs(now, eurcAsset(now, { price: 1.05, priceSource: "pyth" }));
    attachFx(input.pegRates, now - 60).rollbackSupportsPeerEvents = true;
    const plan = planFor(db, row, input);
    if (plan.kind !== "ready") throw new Error("Expected admission to reach the bounded expiry decision");
    await settle(db, plan, plan.evidence, now);
    expect(readLifecycle(sqlite, row.stablecoin_id, row.id).outcomes[0]).toMatchObject({ outcome: "expired" });
  });

  it("does not confirm a native EUR discount with two USD prices at the same value", async () => {
    const { db, sqlite } = openFixture();
    const now = Date.UTC(2026, 10, 14, 12) / 1_000;
    const row = makePendingRow({ stablecoin_id: eurc.id, symbol: "EURC", peg_type: "peggedEUR",
      reason: "native-origin", peg_reference: 1, first_seen_at: now - 1_000, last_seen_at: now - 30,
      first_price: 0.90, last_price: 0.90, peak_price: 0.90, first_seen_bps: -1000, last_seen_bps: -1000, peak_seen_bps: -1000 });
    insertPending(sqlite, row);
    const plan = planFor(db, row, {
      ...eurcInputs(now, eurcAsset(now, { price: 1.10, priceSource: "coinbase" })),
      nativePegQuote: eurcQuote(0.90, now - 30), challengerPools: [eurcPool(1.10, now - 30)],
    });
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error("Expected an active candidate");
    expect(evaluatePromotionDecision({ db, plan, evidence: plan.evidence, now })).toEqual([]);
  });

  it.each([
    { currency: "EUR", reference: 1.1 },
    { currency: "BRL", reference: 0.193 },
  ])("confirms with a $currency trade and preserves the USD peak through rollout skew", async ({ currency, reference }) => {
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
      nativeSignal: deriveDepegSignal(0.90, 1),
      nativePegQuote: { stablecoinId: row.stablecoin_id, geckoId: "non-usd-coin", pegCurrency: currency, price: 0.90, updatedAt: NOW_SEC - 30, derivation: tradedPair },
    });
    const evidence = await collectPlanEvidence(db, plan);
    expect(evidence.offchainPeakCandidate?.price).toBeCloseTo(0.90, 10);
    await settle(db, plan, evidence);
    const state = readLifecycle(sqlite, row.stablecoin_id, row.id);
    expect(state.pending).toBeUndefined();
    expect(state.events[0]).toMatchObject({
      start_price: reference * 0.98, peg_reference: reference, peak_deviation_bps: -200,
    });
    expect(Number(state.events[0].peak_price)).toBeCloseTo(reference * 0.98, 10);
    const hydrated = await hydrateDepegDetection(db, []);
    expect(hydrated.openRows[0]).toMatchObject({ quote_mode: "usd", peak_quote_domain: "usd", peak_peg_reference: reference });
    sqlite.prepare("UPDATE depeg_events SET peak_price = ?, peak_deviation_bps = -1100").run(reference * 1.02 * 0.89);
    const updated = sqlite.prepare("SELECT * FROM depeg_events").get() as unknown as DepegRow;
    expect(rowToDepegEvent(updated).peakPegReference).toBeUndefined();
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
    const evidence = await collectPlanEvidence(db, plan);
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
      row, authoritativePrice: 0.98, ...primaryAgreement,
    });
    const evidence = await collectPlanEvidence(db, plan, {
      poolChallengers: new Map([[row.stablecoin_id, [
        ...["curve", "uniswap"].slice(0, confirmingCount).map((protocol) => ({
          price: 0.8, tvlUsd: 1_000_000, protocol, sourceFamily: protocol, chain: "ethereum", observedAt: NOW_SEC - 30,
        })),
        ...["aerodrome", "balancer"].map((protocol) => ({
          price: 1, tvlUsd: 1_000_000, protocol, sourceFamily: protocol, chain: "ethereum", observedAt: NOW_SEC - 30,
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
      row, authoritativePrice: 0.98, ...primaryAgreement,
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
    const evidence = await collectPlanEvidence(db, plan, {
      poolChallengers: new Map([[row.stablecoin_id, [
        { price: 0.8, tvlUsd: 6_000_000, protocol: "curve", sourceFamily: "curve", chain: "ethereum", observedAt: NOW_SEC - 30 },
        ...["uniswap", "aerodrome"].slice(0, opposingCount).map((protocol) => ({
          price: opposingPrice, tvlUsd: 6_000_000, protocol, sourceFamily: protocol, chain: "ethereum", observedAt: NOW_SEC - 30,
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
      ...primaryAgreement,
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
