import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { StablecoinMeta } from "@shared/types/core";
import type { StablecoinData } from "@shared/types/market";
import { createLatestSchemaSqlite } from "../../test-helpers/latest-schema-sqlite";
import { makeAsset } from "../../test-helpers/__shared/fixtures";
import { DEPEG_PENDING_MIN_AGE_SEC } from "../../lib/constants";
import { normalizePendingDepegRow, type PendingDepegRow } from "../../lib/depeg-pending";
import { buildConfirmationPlan, type ConfirmationPlanInput } from "../pending-depeg-confirmation";

const NOW_SEC = 1_700_000_000;
const openDbs: DatabaseSync[] = [];
const brlMeta: StablecoinMeta = {
  id: "brz-transfero", name: "Brazilian Digital Token", symbol: "BRZ", geckoId: "brz",
  flags: { backing: "rwa-backed", pegCurrency: "BRL", governance: "centralized", yieldBearing: false, rwa: true, navToken: false },
};

function fixture(): { sqlite: DatabaseSync; db: D1Database } { const value = createLatestSchemaSqlite(); openDbs.push(value.sqlite); return value; }
function row(overrides: Partial<PendingDepegRow> = {}): PendingDepegRow {
  const firstSeenAt = overrides.first_seen_at ?? NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC - 60;
  const firstSeenBps = overrides.first_seen_bps ?? -200;
  const firstPrice = overrides.first_price ?? 0.98;
  return { id: 1, stablecoin_id: "usdt-tether", symbol: "USDT", peg_type: "peggedUSD", direction: "below", first_seen_bps: firstSeenBps, first_seen_at: firstSeenAt, first_price: firstPrice, last_seen_bps: firstSeenBps, last_seen_at: firstSeenAt + DEPEG_PENDING_MIN_AGE_SEC, last_price: firstPrice, peak_seen_bps: null, peak_price: null, peg_reference: 1, reason: "large-cap", updated_at: firstSeenAt, ...overrides };
}
function seed(sqlite: DatabaseSync, value: PendingDepegRow): void {
  sqlite.prepare(`INSERT INTO depeg_pending (id, stablecoin_id, symbol, peg_type, direction, first_seen_bps, first_seen_at, first_price, peg_reference, reason, last_seen_bps, last_seen_at, last_price, peak_seen_bps, peak_price, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(value.id, value.stablecoin_id, value.symbol, value.peg_type, value.direction, value.first_seen_bps, value.first_seen_at, value.first_price, value.peg_reference, value.reason ?? "large-cap", value.last_seen_bps, value.last_seen_at, value.last_price, value.peak_seen_bps, value.peak_price, value.updated_at ?? value.last_seen_at ?? value.first_seen_at);
}

type Spec = {
  label: string;
  row?: Partial<PendingDepegRow>;
  asset?: Partial<StablecoinData>;
  meta?: StablecoinMeta;
  rates?: Record<string, number>;
  rateSources?: Record<string, "median" | "fx" | "fallback">;
  rateCounts?: Record<string, number>;
  nativePrice?: number;
  open?: boolean;
  kind: "mutate" | "wait" | "ready";
  reason?: string;
  outcome?: string;
  peg?: number;
};
const usdPyth: Partial<StablecoinData> = { geckoId: undefined, price: 1, priceSource: "pyth", priceConfidence: "single-source", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30, consensusSources: ["pyth"], agreeSources: ["pyth"] };
const brz: Partial<StablecoinData> = { id: "brz-transfero", name: "Brazilian Digital", symbol: "BRZ", geckoId: "brz", pegType: "peggedREAL", price: 0.3 };
const PLAN_CASES: Spec[] = [
  { label: "rejects an invalid stored peg reference", row: { id: 1, peg_reference: 0 }, kind: "mutate", outcome: "rejected", reason: "invalid-peg-reference:0" },
  { label: "keeps the stored pending peg reference when the refreshed fiat median is thin", row: { id: 2, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.3 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 1 }, kind: "ready", peg: 0.18765951 },
  { label: "waits instead of deleting when a thin fiat reference has no valid stored reference", row: { id: 3, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", peg_reference: 0 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.3 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 1 }, kind: "wait", reason: "peg-reference-unavailable" },
  { label: "clears BRZ pending rows when the direct BRL quote is back inside threshold", row: { id: 4, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", first_seen_bps: 180, first_price: 0.190587, peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 2 }, nativePrice: 0.995, kind: "mutate", outcome: "recovered", reason: "native-peg-recovered" },
  { label: "clears BRZ pending rows when the native quote is below the full confirmation bar", row: { id: 5, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", direction: "above", first_seen_bps: 180, first_price: 0.190587, peg_reference: 0.18765951 }, asset: brz, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 2 }, nativePrice: 1.01, kind: "mutate", outcome: "recovered", reason: "native-peg-recovered" },
  { label: "clears a pending row when the authoritative primary recovered", row: { id: 6 }, asset: usdPyth, kind: "mutate", outcome: "recovered", reason: "authoritative-primary-recovered" },
  { label: "supersedes a pending row when an open event already exists", row: { id: 7 }, open: true, kind: "mutate", outcome: "superseded", reason: "open-event-already-exists" },
  { label: "does not promote before threshold observations span the full window", row: { id: 8, first_seen_at: NOW_SEC - DEPEG_PENDING_MIN_AGE_SEC + 60 }, kind: "wait", reason: "too-young" },
  { label: "retains native-origin state while waiting for independent confirmation", row: { id: 9, stablecoin_id: "brz-transfero", symbol: "BRZ", peg_type: "peggedREAL", first_seen_bps: -242, first_price: 0.18, peg_reference: 1, reason: "large-cap+native-origin" }, asset: { ...brz, price: 0.18, priceSource: "pyth", priceConfidence: "single-source", priceObservedAt: NOW_SEC - 30, priceUpdatedAt: NOW_SEC - 30, priceSyncedAt: NOW_SEC - 30, consensusSources: ["pyth"], agreeSources: ["pyth"] }, meta: brlMeta, rates: { peggedREAL: 0.18765951 }, rateSources: { peggedREAL: "median" }, rateCounts: { peggedREAL: 2 }, kind: "ready", peg: 1 },
  { label: "returns a ready plan for an aged pending row", row: { id: 10 }, kind: "ready", peg: 1 },
];

function makeInput(db: D1Database, spec: Spec): ConfirmationPlanInput {
  const value = row(spec.row);
  const pendingState = normalizePendingDepegRow(value);
  const asset = spec.asset ? makeAsset({ id: value.stablecoin_id, symbol: value.symbol, ...spec.asset }) : undefined;
  return { db, row: value, pendingState, asset, meta: spec.meta, pegRates: spec.rates ?? {}, pegRateSources: spec.rateSources ?? {}, pegRateCounts: spec.rateCounts ?? {}, nativePegQuote: spec.nativePrice == null ? undefined : { stablecoinId: value.stablecoin_id, geckoId: spec.meta?.geckoId ?? "brz", pegCurrency: spec.meta?.flags.pegCurrency ?? "BRL", price: spec.nativePrice, updatedAt: NOW_SEC - 60 }, openSet: spec.open ? new Set([value.stablecoin_id]) : new Set(), now: NOW_SEC };
}

afterEach(() => { for (const sqlite of openDbs.splice(0)) sqlite.close(); });

describe("buildConfirmationPlan", () => {
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
      expect(sqlite.prepare("SELECT id FROM depeg_pending WHERE id = ?").get(input.row.id)).toBeUndefined();
      return;
    }
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") throw new Error(`unexpected plan kind: ${plan.kind}`);
    expect(plan.pegReference).toBe(spec.peg);
    expect(plan.outcomeState.pegReference).toBe(spec.peg);
    expect(plan.age).toBeGreaterThanOrEqual(DEPEG_PENDING_MIN_AGE_SEC);
    if (input.row.reason?.includes("native-origin")) expect(plan.nativeSourceKey).toBe("native:brl");
  });
});
