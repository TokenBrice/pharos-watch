import { DEPEG_PENDING_EXPIRY_SEC, DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/stablecoin-meta-schemas";
import type { StablecoinData } from "@shared/types/supply";
import {
  insertPendingDepeg,
  makePendingDepegRow,
  openLatestSchemaFixture,
} from "../../test-helpers/pending-depeg-fixtures";
import { makeAsset } from "../../test-helpers/__shared/fixtures";

import { buildPendingClosureHoldStatements, hasCurrentPendingClosureVerdict, buildUpsertPendingDepegStmt, normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import { evaluatePromotionDecision } from "../pending-depeg-confirmation-decision";
import { buildConfirmationPlan, type ConfirmationPlanInput } from "../pending-depeg-confirmation";

import { attachDetectionReferenceContext } from "../depeg-detection/reference-policy";
import { referenceState, tradedPair } from "../depeg-detection/__tests__/reference-fixtures";

const NOW_SEC = 1_700_000_000;
const openDbs: DatabaseSync[] = [];
const brlMeta: StablecoinMeta = {
  id: "brz-transfero", name: "Brazilian Digital Token", symbol: "BRZ", geckoId: "brz",
  flags: { backing: "rwa-backed", pegCurrency: "BRL", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
};
const goldMeta: StablecoinMeta = { ...brlMeta, flags: { ...brlMeta.flags, pegCurrency: "GOLD" } };
const eurMeta: StablecoinMeta = {
  id: "ceur-celo", name: "Celo Euro", symbol: "EURm", geckoId: "celo-euro",
  flags: { backing: "rwa-backed", pegCurrency: "EUR", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
};

function fixture(): { sqlite: DatabaseSync; db: D1Database } { return openLatestSchemaFixture({ openDatabases: openDbs }); }
const row = makePendingDepegRow;
const seed = insertPendingDepeg;

type Spec = {
  label: string;
  row?: Partial<PendingDepegRow>;
  asset?: Partial<StablecoinData>;
  meta?: StablecoinMeta;
  rates?: Record<string, number>;
  rateSources?: Record<string, "median" | "fx" | "fallback">;
  rateCounts?: Record<string, number>;
  nativePrice?: number;
  nativeOnsetVenue?: string;
  open?: boolean;
  now?: number;
  kind: "mutate" | "wait" | "ready";
  reason?: string;
  outcome?: string;
  peg?: number;
  threshold?: number;
  primarySources?: string[];
  opposingSources?: string;
};
const usdPyth: Partial<StablecoinData> = { geckoId: undefined, price: 1, priceSource: "pyth", priceConfidence: "single-source", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30, consensusSources: ["pyth"], agreeSources: ["pyth"] };
const brz: Partial<StablecoinData> = { id: "brz-transfero", name: "Brazilian Digital", symbol: "BRZ", geckoId: "brz", pegType: "peggedREAL", price: 0.3 };
const nativeBrz = (price: number): Partial<StablecoinData> => ({
  ...brz,
  price,
  priceSource: "pyth",
  priceConfidence: "single-source",
  priceObservedAt: NOW_SEC - 30,
  priceUpdatedAt: NOW_SEC - 30,
  priceSyncedAt: NOW_SEC - 30,
  consensusSources: ["pyth"],
  agreeSources: ["pyth"],
});
const PLAN_CASES: Spec[] = [
  { label: "rejects an invalid stored peg reference", row: { id: 1, peg_reference: 0 }, kind: "mutate", outcome: "rejected", reason: "invalid-peg-reference:0" },
  { label: "waits when the refreshed fiat median is thin despite a stored reference", row: { id: 2, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.3 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 1 }, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "waits instead of deleting when a thin fiat reference has no valid stored reference", row: { id: 3, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 0 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.3 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 1 }, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "clears BRZ pending rows when the direct BRL quote is back inside threshold", row: { id: 4, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", first_seen_bps: 180, first_price: 0.190587, peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 2 }, nativePrice: 0.995, kind: "mutate", outcome: "recovered", reason: "native-peg-recovered" },
  { label: "retains BRZ pending rows in the gap between recovery and promotion", row: { id: 5, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", first_seen_bps: 180, first_price: 0.190587, peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 2 }, nativePrice: 1.01, kind: "ready", peg: 0.18765951 },
  { label: "clears a pending row when the authoritative primary recovered", row: { id: 6 }, asset: usdPyth, kind: "mutate", outcome: "recovered", reason: "authoritative-primary-recovered" },
  { label: "orders a legacy USD recovery by the authoritative quote update", row: { last_seen_at: NOW_SEC - 120 },
    asset: { ...usdPyth, priceObservedAtMode: undefined, priceObservedAt: undefined }, kind: "mutate", outcome: "recovered", reason: "authoritative-primary-recovered" },
  { label: "withholds a legacy USD recovery older than the retained pending quote", row: { last_seen_at: NOW_SEC - 120 },
    asset: { ...usdPyth, priceObservedAtMode: undefined, priceObservedAt: undefined, priceUpdatedAt: NOW_SEC - 121 }, kind: "ready", peg: 1 },
  { label: "withholds an explicitly local-fetch USD recovery even with a fresh update", asset: { ...usdPyth, priceSource: "pyth+binance", priceConfidence: "high", agreeSources: ["pyth", "binance"], priceObservedAtMode: "local_fetch", priceObservedAt: null }, kind: "ready", peg: 1 },
  { label: "supersedes a pending row when an open event already exists", row: { id: 7 }, open: true, kind: "mutate", outcome: "superseded", reason: "open-event-already-exists" },
  { label: "does not promote before threshold observations span the full window", row: { id: 8, first_seen_at: NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC + 60 }, kind: "wait", reason: "too-young" },
  { label: "waits on native-origin state when benchmark and native evidence are unavailable", row: { id: 9, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", first_seen_bps: -242, first_price: 0.18, peg_reference: 1, reason: "large-cap+native-origin" }, asset: { ...brz, price: 0.18, priceSource: "pyth", priceConfidence: "single-source", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30, consensusSources: ["pyth"], agreeSources: ["pyth"] }, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 2 }, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "credits a fresh independent primary source when a native-origin move persists", row: { id: 11, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", first_seen_bps: -940, first_price: 0.17, last_seen_bps: -940, last_price: 0.17, peak_seen_bps: -940, peak_price: 0.17, peg_reference: 1, reason: "large-cap+native-origin" }, asset: nativeBrz(0.0319021167), meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 1 }, nativeOnsetVenue: "bitso", kind: "ready", peg: 1, primarySources: ["primary:oracle:pyth"] },
  { label: "records a fresh independent primary source when a native-origin move recovers", row: { id: 12, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", first_seen_bps: -242, first_price: 0.9758, peg_reference: 1, reason: "large-cap+native-origin" }, asset: nativeBrz(0.18765951), meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 1 }, nativeOnsetVenue: "bitso", kind: "mutate", outcome: "recovered", reason: "authoritative-primary-recovered", opposingSources: "primary:oracle:pyth+primary:authoritative" },
  { label: "withholds a pending event whose peg differs from its asset and registry", row: { id: 13, stablecoin_id: brlMeta.id, peg_type: "peggedUSD" }, asset: brz, meta: brlMeta, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "withholds a mismatched asset even with an agreeing pending peg and native quote", row: { stablecoin_id: brlMeta.id, peg_type: "peggedREAL" }, asset: { ...brz, pegType: "peggedUSD" }, meta: brlMeta, nativePrice: 1, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "returns a ready plan for an aged pending row", row: { id: 10 }, kind: "ready", peg: 1 },
  { label: "does not mark a closure hold when the candidate lacks a current quote", row: { id: 14 }, meta: goldMeta, now: 1_794_758_400, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "holds from a current sub-band sample during the closure", row: { id: 15, peg_type: "peggedGOLD", last_seen_bps: -200 }, asset: { price: 3_880, pegType: "peggedGOLD" }, meta: goldMeta, rates: { peggedGOLD: 3_880 }, rateSources: { peggedGOLD: "fallback" }, now: 1_794_758_400, kind: "wait", reason: "reference-market-closed" },
  { label: "holds a 24.996% primary reading below the raw closure cutoff", row: { id: 16, peg_type: "peggedEUR" }, asset: { price: 0.75004, pegType: "peggedEUR" }, meta: eurMeta, rates: { peggedEUR: 1 }, rateSources: { peggedEUR: "fx" }, nativePrice: 0.755, now: 1_794_758_400, kind: "wait", reason: "reference-market-closed" },
  { label: "assesses a traded native-origin FX candidate through the closed session", row: { id: 17, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", first_seen_bps: -242, first_price: 0.98, peg_reference: 1, reason: "large-cap+native-origin" }, asset: nativeBrz(0.18765951), meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 1 }, nativePrice: 0.98, now: 1_794_758_400, kind: "ready", peg: 1, threshold: 150 },
  { label: "does not treat a 24.5% native discount as recovery from a 25.5% weekend primary discount",
    row: { id: 18, peg_type: "peggedEUR", last_seen_bps: -2550 }, asset: { price: 0.8195, pegType: "peggedEUR" },
    meta: eurMeta, rates: { peggedEUR: 1.1 }, rateSources: { peggedEUR: "fx" }, nativePrice: 0.755,
    now: 1_794_758_400, kind: "ready", peg: 1.1, threshold: 2500 },

];

function makeInput(db: D1Database, spec: Omit<Spec, "label">): ConfirmationPlanInput {
  const value = row(spec.now == null ? spec.row : {
    first_seen_at: spec.now - 1_000, last_seen_at: spec.now - 30, ...spec.row,
  });
  if (spec.nativeOnsetVenue) {
    value.peer_basis_json = JSON.stringify({ onset: { basis: "native-peg", observedAt: value.first_seen_at,
      price: value.first_price, pegReference: 1, bps: value.first_seen_bps, venue: spec.nativeOnsetVenue } });
  }
  const pendingState = normalizePendingDepegRow(value);
  const now = spec.now ?? NOW_SEC;
  const asset = spec.asset ? makeAsset({ id: value.stablecoin_id, symbol: value.symbol,
    priceObservedAt: now - 30, priceUpdatedAt: now - 30, priceObservedAtMode: "upstream",
    ...spec.asset, ...(spec.now ? { priceObservedAt: now - 30, priceUpdatedAt: now - 30 } : {}),
  }) : undefined;
  const pegRates = { ...spec.rates };
  const referenceAt = spec.now ? Date.UTC(2026, 10, 13, 21, 55) / 1_000 : now - 60;
  const fx = referenceState(pegRates, referenceAt);
  attachDetectionReferenceContext(pegRates, [], new Map(), new Set(), fx, fx.repricingByPeg);
  return { db, row: value, pendingState, asset, meta: spec.meta, pegRates, pegRateSources: spec.rateSources ?? {},
    pegRateCounts: spec.rateCounts ?? {}, nativePegQuote: spec.nativePrice == null ? undefined : {
      stablecoinId: value.stablecoin_id, geckoId: spec.meta?.geckoId ?? "brz", pegCurrency: spec.meta?.flags.pegCurrency ?? "BRL",
      price: spec.nativePrice, updatedAt: now - 60, derivation: tradedPair,
    }, openSet: spec.open ? new Set([value.stablecoin_id]) : new Set(), now };

}

afterEach(() => { for (const sqlite of openDbs.splice(0)) sqlite.close(); });

describe("buildConfirmationPlan", () => {
  it.each(["clocked", "legacy"] as const)("continues a severe pre-close pending using the %s weekend reference", (mode) => {
    const { db } = fixture();
    const close = Date.UTC(2026, 10, 13, 22) / 1000;
    const now = close + 2.5 * 3600;
    const input = makeInput(db, { kind: "ready", now, meta: eurMeta, rates: { peggedEUR: 1.1 },
      rateSources: { peggedEUR: "fx" }, asset: { pegType: "peggedEUR", price: 0.77, priceSource: "coingecko" },
      row: { stablecoin_id: eurMeta.id, peg_type: "peggedEUR", first_seen_at: close - 1800, last_seen_at: close - 900,
        first_seen_bps: -3000, last_seen_bps: -3000, peak_seen_bps: -3000, peg_reference: 1.1 } });
    if (mode === "legacy") attachDetectionReferenceContext(input.pegRates, [], new Map(), new Set(), null);
    const plan = buildConfirmationPlan(input);
    expect(plan).toMatchObject({ kind: "ready", threshold: 2500 });
    if (plan.kind !== "ready") throw new Error("Expected a weekend confirmation attempt");
    expect(evaluatePromotionDecision({ db, plan, evidence: plan.evidence, now })).toEqual([]);
    expect(buildConfirmationPlan({ ...input, asset: { ...input.asset!, price: 1.09 } }))
      .toMatchObject({ kind: "wait", reason: "reference-market-closed" });
    if (mode === "legacy") expect(buildConfirmationPlan({ ...input, asset: undefined }))
      .toEqual({ kind: "wait", reason: "reference-market-closed", legacyClosure: true });
    else expect(buildConfirmationPlan({ ...input, asset: undefined }))
      .toEqual({ kind: "wait", reason: "peg-reference-unavailable" });
    const monday = Date.UTC(2026, 10, 16, 12) / 1000;
    expect(buildConfirmationPlan({ ...input, asset: undefined, now: monday }).kind).toBe("mutate");
  });

  it("ages a lagged quote from the run that found it and requires a later quote for persistence", async () => {
    const { sqlite, db } = fixture();
    const pending = { stablecoinId: "usdt-tether", symbol: "USDT", pegType: "peggedUSD", direction: "below" as const,
      bps: -200, price: 0.98, pegReference: 1, reason: "confirmation-window" };
    const write = (seenAt: number, quoteObservedAt: number) =>
      buildUpsertPendingDepegStmt(db, { ...pending, seenAt, quoteObservedAt }).run();
    const planAt = (now: number) => {
      const row = sqlite.prepare("SELECT * FROM depeg_pending").get() as unknown as PendingDepegRow;
      return buildConfirmationPlan({ ...makeInput(db, { kind: "ready" }), row, pendingState: normalizePendingDepegRow(row), now });
    };

    const oldTrade = NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC;
    const nextRun = NOW_SEC + DEPEG_PENDING_MIN_AGE_SEC;
    await write(NOW_SEC, oldTrade);
    expect(planAt(NOW_SEC)).toMatchObject({ kind: "wait", reason: "too-young" });
    await write(nextRun, oldTrade);
    expect(planAt(nextRun)).toMatchObject({ kind: "ready", age: DEPEG_PENDING_MIN_AGE_SEC, temporalSameDirectionConfirmed: false });
    await write(nextRun, NOW_SEC + 1);
    expect(planAt(nextRun)).toMatchObject({ kind: "ready", age: DEPEG_PENDING_MIN_AGE_SEC, temporalSameDirectionConfirmed: true });
    const terminalAt = (now: number) => {
      const plan = planAt(now);
      if (plan.kind !== "ready") throw new Error("Expected an aged USD candidate");
      return evaluatePromotionDecision({ db, plan, evidence: plan.evidence, now });
    };
    const expiry = NOW_SEC + DEPEG_PENDING_EXPIRY_SEC;
    expect(terminalAt(expiry)).toHaveLength(0);
    await db.batch(terminalAt(expiry + 1));
    expect(sqlite.prepare("SELECT outcome FROM depeg_pending_outcomes").get()).toEqual({ outcome: "expired" });
  });

  it.each([
    { stablecoinId: "another-coin", pegCurrency: "BRL" },
    { stablecoinId: "brz-transfero", pegCurrency: "EUR" },
  ])("keeps a pending episode when a recovered quote has mismatched identity $stablecoinId/$pegCurrency", ({ stablecoinId, pegCurrency }) => {
    const { db } = fixture();
    const input = makeInput(db, {
      row: { stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 1, reason: "large-cap+native-origin" },
      asset: brz, meta: brlMeta, rates: { peggedREAL: 0.193 }, rateSources: { peggedREAL: "fx" },
      kind: "ready",
    });
    input.nativePegQuote = { stablecoinId, pegCurrency, geckoId: "brz", price: 1, updatedAt: NOW_SEC - 30 };
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.nativeSignal).toBeNull();
    expect(plan.authoritativePrice).toBeNull();
    expect(plan.nativePegQuote).toBeUndefined();
    expect(plan.evidence.unavailableSources).toContain("native:brl");
  });

  it.each(["BRL", "brl", " bRl "])("admits recovered native quotes through canonical currency mapping %j", async (pegCurrency) => {
    const { sqlite, db } = fixture();
    const input = makeInput(db, {
      row: { stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 1, reason: "large-cap+native-origin" },
      asset: brz, meta: brlMeta, nativePrice: 1, nativeOnsetVenue: "bitso", kind: "mutate",
    });
    input.nativePegQuote = { ...input.nativePegQuote!, pegCurrency };
    seed(sqlite, input.row);
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("mutate");
    if (plan.kind !== "mutate") throw new Error(`unexpected plan kind: ${plan.kind}`);
    await db.batch(plan.statements);
    expect(sqlite.prepare("SELECT outcome, final_decision_reason FROM depeg_pending_outcomes WHERE pending_id = ?").get(input.row.id))
      .toEqual({ outcome: "recovered", final_decision_reason: "native-peg-recovered" });
  });

  it.each(["native", "primary"] as const)("withholds an older %s recovery after a newer retained dislocation", (basis) => {
    const { db } = fixture();
    const input = makeInput(db, {
      row: { stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 1,
        first_seen_at: NOW_SEC - 1_600, last_seen_at: NOW_SEC - 50, reason: "large-cap+native-origin" },
      asset: nativeBrz(basis === "native" ? 0.18 : 0.193), meta: brlMeta,
      rates: { peggedREAL: 0.193 }, rateSources: { peggedREAL: "fx" }, rateCounts: { peggedREAL: 1 },
      nativePrice: basis === "native" ? 1 : undefined, nativeOnsetVenue: "bitso", kind: "ready",
    });
    if (input.nativePegQuote) input.nativePegQuote = { ...input.nativePegQuote, updatedAt: NOW_SEC - 700 };
    input.asset = { ...input.asset!, priceObservedAt: NOW_SEC - 700 };
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("ready");
    if (plan.kind === "ready") {
      expect(plan.primaryStatus).not.toBe("recover");
      expect(plan.nativeSignal).toBeNull();
    }
  });

  it("withholds an implausible native-origin sample as unavailable evidence", () => {
    const { db } = fixture();
    const input = makeInput(db, {
      row: { id: 14, stablecoin_id: "ceur-celo", symbol: "EURm", peg_type: "peggedEUR", direction: "above", first_seen_bps: 15_984, first_price: 2.598389348610164, last_seen_bps: 15_984, last_price: 2.598389348610164, peak_seen_bps: 15_984, peak_price: 2.598389348610164, peg_reference: 1, reason: "large-cap+native-origin" },
      asset: { id: "ceur-celo", symbol: "EURm", pegType: "peggedEUR", price: 1.16 },
      meta: eurMeta,
      rates: { peggedEUR: 1.16 },
      rateSources: { peggedEUR: "fx" },
      rateCounts: { peggedEUR: 4 },
      kind: "ready",
      peg: 1,
    });
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.nativeSignal).toBeNull();
    expect(plan.authoritativePrice).toBeNull();
    expect(plan.nativeQuoteImplausibility?.reason).toBe("native-quote-above-peg-reference-band");
    expect(plan.evidence.unavailableSources).toContain("native:eur:native-quote-above-peg-reference-band");
  });

  it("admits an extreme native-origin sample corroborated by an independent source family", () => {
    const { db } = fixture();
    const input = makeInput(db, {
      row: { id: 15, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "below", first_seen_bps: -6_000, first_price: 0.4, last_seen_bps: -6_000, last_price: 0.4, peak_seen_bps: -6_000, peak_price: 0.4, peg_reference: 1, reason: "large-cap+native-origin" },
      asset: nativeBrz(0.075),
      nativeOnsetVenue: "bitso",
      meta: brlMeta,
      rates: { peggedREAL: 0.18765951 },
      rateSources: { peggedREAL: "fx" },
      rateCounts: { peggedREAL: 1 },
      kind: "ready",
      peg: 1,
    });
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.nativeQuoteImplausibility).toBeNull();
    expect(plan.evidence.unavailableSources).not.toContain("native:brl:native-quote-extreme-move");
  });

  it("does not record a recovery from an implausible native-origin sample", () => {
    const { db } = fixture();
    const input = makeInput(db, {
      row: { id: 16, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "below", first_seen_bps: -940, first_price: 0.17, last_seen_bps: -940, last_price: 0.17, peak_seen_bps: -940, peak_price: 0.17, peg_reference: 1, reason: "large-cap+native-origin" },
      asset: nativeBrz(0.18765951),
      meta: brlMeta,
      rates: { peggedREAL: 0.18765951 },
      rateSources: { peggedREAL: "fx" },
      rateCounts: { peggedREAL: 1 },
      kind: "ready",
      peg: 1,
    });
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.nativeQuoteImplausibility?.reason).toBe("native-quote-extreme-move");
    expect(plan.evidence.unavailableSources).toContain("native:brl:native-quote-extreme-move");
  });

  it("does not record a closure hold from a numeric fallback without denominator metadata", () => {
    const { db } = fixture();
    const input = makeInput(db, PLAN_CASES.find((spec) => spec.row?.id === 15)!);
    input.pegRates = { ...input.pegRates };
    expect(buildConfirmationPlan(input)).toEqual({ kind: "wait", reason: "reference-market-closed", legacyClosure: true });
  });

  it("binds a hold verdict to a pending episode revision", async () => {
    const { sqlite, db } = fixture();
    const input = makeInput(db, PLAN_CASES.find((spec) => spec.row?.id === 15)!);
    seed(sqlite, input.row);
    expect(buildConfirmationPlan(input)).toEqual({ kind: "wait", reason: "reference-market-closed" });
    const readHold = () => sqlite.prepare("SELECT reference_market_held_at FROM depeg_pending WHERE id = ?").get(input.row.id);
    await db.batch(buildPendingClosureHoldStatements(db, input.row, input.now));
    expect(readHold()).toEqual({ reference_market_held_at: input.now });
    const readRow = () => sqlite.prepare("SELECT * FROM depeg_pending WHERE id = ?").get(input.row.id) as unknown as PendingDepegRow;
    expect(hasCurrentPendingClosureVerdict(readRow())).toBe(true);
    sqlite.prepare("UPDATE depeg_pending SET reference_market_held_at = ? WHERE id = ?").run(input.now + 60, input.row.id);
    expect(hasCurrentPendingClosureVerdict(readRow())).toBe(false);
    sqlite.prepare("UPDATE depeg_pending SET reference_market_held_at = NULL WHERE id = ?").run(input.row.id);
    await db.batch(buildPendingClosureHoldStatements(db, readRow(), null));
    expect(JSON.parse(readRow().peer_basis_json!)).not.toHaveProperty("closureRevision");
    await db.batch(buildPendingClosureHoldStatements(db, readRow(), input.now));
    sqlite.prepare("UPDATE depeg_pending SET peak_price = ? WHERE id = ?").run(0.7, input.row.id);
    expect(hasCurrentPendingClosureVerdict(readRow())).toBe(false);
    await buildUpsertPendingDepegStmt(db, {
      stablecoinId: input.row.stablecoin_id, symbol: input.row.symbol, pegType: input.row.peg_type,
      direction: "below", bps: -3_000, seenAt: input.now + 60, price: 0.7, pegReference: 1, reason: "large-cap",
    }).run();
    await db.batch(buildPendingClosureHoldStatements(db, input.row, input.now));
    expect(readHold()).toEqual({ reference_market_held_at: null });
  });

  it.each(PLAN_CASES)("$label", async (spec) => {
    const { sqlite, db } = fixture();
    const input = makeInput(db, spec);
    seed(sqlite, input.row);
    const plan = buildConfirmationPlan(input);
    expect(plan.kind).toBe(spec.kind);
    if (spec.kind === "wait") {
      expect(plan).toEqual({ kind: "wait", reason: spec.reason });
      return;
    }
    if (spec.kind === "mutate") {
      expect(plan.kind).toBe("mutate");
      if (plan.kind !== "mutate") throw new Error(`unexpected plan kind: ${plan.kind}`);
      expect(plan.statements).toHaveLength(2);
      await db.batch(plan.statements);
      expect(sqlite.prepare("SELECT outcome, final_decision_reason FROM depeg_pending_outcomes WHERE pending_id = ?").get(input.row.id)).toEqual({ outcome: spec.outcome, final_decision_reason: spec.reason });
      if (spec.opposingSources) {
        expect(sqlite.prepare("SELECT opposing_sources FROM depeg_pending_outcomes WHERE pending_id = ?").get(input.row.id)).toEqual({ opposing_sources: spec.opposingSources });
      }
      expect(sqlite.prepare("SELECT id FROM depeg_pending WHERE id = ?").get(input.row.id)).toBeUndefined();
      return;
    }
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.pegReference).toBe(spec.peg);
    expect(plan.outcomeState.pegReference).toBe(input.row.peg_reference);
    if (spec.threshold != null) expect(plan.threshold).toBe(spec.threshold);
    expect(plan.age).toBeGreaterThanOrEqual(DEPEG_PENDING_MIN_AGE_SEC);
    if (spec.primarySources) expect(plan.primaryConfirmationSources).toEqual(spec.primarySources);
    if (input.row.reason?.includes("native-origin")) expect(plan.nativeSourceKey).toBe("native:brl");
  });
});
