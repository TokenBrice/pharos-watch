import { z } from "zod";
import type { ReserveSlice, ReserveAdapterCoin } from "@shared/types/core";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  fetchJsonWithRetry,
  parseFiniteNumber,
  requireJsonInput,
  requireRecord,
  reserveDegradedWarning,
  verifiedFreshnessMetadata,
} from "./helpers";

export const FRNT_LEDGERLENS_URL = "https://dashboard.ledgerlens.io/_serverFn/48773d105fce9df473395d17bdd97f0cc8215fa6b7fa5355237e98db44e0ab8f";
const KEY = "frnt-ledgerlens";
const EVM_TOKEN = "0x5e817f2abccb9095585d26c2a3ce234a440574fc";
const SOLANA_TOKEN = "FRNTPi9V3Sw9b9U8d5Q3WY7tNANT6Q394d7dYtv7Jdog";
const CHAINS: Record<string, true> = { arbitrum: true, optimism: true, ethereum: true, base: true, polygon: true, avalanche: true, hedera: true, solana: true };
const TYPES = ["TREASURY_BILLS", "REPURCHASE_AGREEMENTS", "CASH"] as const;
const CLASSIFICATION: Record<string, Omit<ReserveSlice, "pct">> = {
  TREASURY_BILLS: { sourceKey: "frnt-ledgerlens:fbo:treasury-bills", name: "U.S. Treasury bills in FBO trust accounts", risk: "very-low", assetClass: "treasury-bill", issuerOrObligor: "United States Treasury", riskFactors: ["duration", "liquidity", "custody"], liquidityHorizon: "one-day" },
  REPURCHASE_AGREEMENTS: { sourceKey: "frnt-ledgerlens:fbo:repurchase-agreements", name: "Treasury-collateralized repurchase agreements in FBO trust accounts", risk: "low", assetClass: "repo", issuerOrObligor: "Undisclosed repo counterparties", riskFactors: ["counterparty", "liquidity", "custody"], liquidityHorizon: "unknown" },
  CASH: { sourceKey: "frnt-ledgerlens:fbo:cash", name: "USD cash in FBO trust accounts", risk: "very-low", assetClass: "bank-deposit", issuerOrObligor: "Fiduciary Trust International / Bank of New York Mellon", riskFactors: ["counterparty", "custody"], liquidityHorizon: "one-day" },
};

// TanStack's public loader returns Seroval JSON. Read only its plain data
// subtree; no upstream JavaScript, reference nodes or custom types execute.
function fields(node: unknown): Record<string, unknown> {
  const value = requireRecord(node, `${KEY} object node`);
  const props = requireRecord(value.p, `${KEY} object properties`);
  if (value.t !== 10 || !Array.isArray(props.k) || !Array.isArray(props.v)
    || props.k.length !== props.v.length || props.k.length > 100
    || props.k.some((key) => typeof key !== "string") || new Set(props.k).size !== props.k.length) {
    throw new Error(`${KEY}: malformed serialized object`);
  }
  const values = props.v;
  return Object.fromEntries(props.k.map((key, index) => [key, values[index]]));
}

function decodeData(node: unknown, depth = 0, budget = { remaining: 4096 }): unknown {
  if (depth > 20 || --budget.remaining < 0) throw new Error(`${KEY}: oversized serialized data`);
  const value = requireRecord(node, `${KEY} data node`);
  if (value.t === 0 && typeof value.s === "number" && Number.isFinite(value.s)) return value.s;
  if (value.t === 1 && typeof value.s === "string") return value.s;
  if (value.t === 9 && Array.isArray(value.a) && value.a.length <= 256) {
    return value.a.map((child) => decodeData(child, depth + 1, budget));
  }
  if (value.t === 10) {
    return Object.fromEntries(Object.entries(fields(value)).map(([key, child]) => [key, decodeData(child, depth + 1, budget)]));
  }
  throw new Error(`${KEY}: unsupported serialized data node`);
}

const DecimalStringSchema = z.string().refine((value) => {
  const [whole, fraction, ...rest] = value.split(".");
  return rest.length === 0 && /^\d+$/.test(whole ?? "") && (fraction === undefined || /^\d+$/.test(fraction));
});
const AmountSchema = z.union([DecimalStringSchema, z.number().finite().nonnegative()]);
const ValueSchema = z.object({ rawValue: AmountSchema, value: AmountSchema });
const SnapshotSchema = z.object({
  _id: z.string().regex(/^[a-f\d]{24}$/),
  createdAt: z.string().datetime(),
  summary: z.object({
    liquidityFundDueAdminAccount: AmountSchema, liquidityAccountNetFmv: AmountSchema,
    fboTrustDueAdminAccount: AmountSchema, totalHedge: AmountSchema, totalLiabilities: AmountSchema,
    fboTrustUsdTotal: AmountSchema, fboTrustSecuritiesTotal: AmountSchema,
    liquidityFundUsdTotal: AmountSchema, liquidityFundSecuritiesTotal: AmountSchema, trustAccountNetFmv: AmountSchema,
  }),
  balances: z.array(z.object({
    source: z.string(), label: z.string(), side: z.enum(["assets", "liabilities"]),
    asset: z.string(), type: z.literal("spot"), rawValue: AmountSchema, value: AmountSchema,
    breakdown: z.union([
      z.array(z.object({ chain: z.string(), address: z.string(), rawValue: AmountSchema, value: AmountSchema })).min(1).max(32),
      z.object({
        byType: z.record(z.string(), ValueSchema), byAccount: z.record(z.string(), ValueSchema),
        items: z.array(z.object({ type: z.string(), account: z.string(), cusip: z.string().min(1), fmv: AmountSchema, rawFmv: AmountSchema })).min(1).max(256),
      }),
    ]),
  })).length(2),
});

function amount(value: unknown): number {
  return parseFiniteNumber(value, { label: KEY, min: 0 });
}
function reconcile(actual: number, expected: number, label: string): void {
  // Dashboard values round raw supply to cents; no portfolio haircut is hidden.
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.010001) {
    throw new Error(`${KEY}: ${label} does not reconcile`);
  }
}
function readValue(value: { rawValue: unknown; value: unknown }): number {
  const raw = amount(value.rawValue);
  reconcile(raw, amount(value.value), "raw/display amount");
  return raw;
}

export function adaptFrntLedgerlens(payload: unknown): AdapterResult {
  const snapshot = fields(fields(fields(payload).result).lastActiveSnapshot);
  const data = SnapshotSchema.parse(Object.fromEntries(
    ["_id", "createdAt", "summary", "balances"].map((key) => [key, decodeData(snapshot[key])]),
  ));
  const assets = data.balances.find((row) => row.side === "assets");
  const liability = data.balances.find((row) => row.side === "liabilities");
  if (!assets || !liability || assets.asset !== "USD" || assets.source !== "sftp" || assets.label !== "assets-sftp"
    || liability.asset !== "FRNT" || liability.source !== "blockchain" || liability.label !== "liabilities-blockchain"
    || Array.isArray(assets.breakdown) || !Array.isArray(liability.breakdown)) {
    throw new Error(`${KEY}: unexpected reserve/liability scope`);
  }
  const { byType, byAccount, items } = assets.breakdown;
  if (Object.keys(byType).length !== TYPES.length || TYPES.some((type) => !byType[type])
    || Object.keys(byAccount).length !== 1 || !byAccount.FBO_TRUST) {
    throw new Error(`${KEY}: unreviewed reserve category or account`);
  }
  const totals = Object.fromEntries(TYPES.map((type) => [type, readValue(byType[type])]));
  const itemTotals: Record<string, number> = {};
  const itemIds = new Set<string>();
  for (const row of items) {
    if (!Object.prototype.hasOwnProperty.call(CLASSIFICATION, row.type) || row.account !== "FBO_TRUST" || itemIds.has(row.cusip)) {
      throw new Error(`${KEY}: duplicate or unreviewed reserve item`);
    }
    itemIds.add(row.cusip);
    const value = amount(row.rawFmv);
    reconcile(value, amount(row.fmv), "item valuation");
    itemTotals[row.type] = (itemTotals[row.type] ?? 0) + value;
  }
  for (const type of TYPES) reconcile(itemTotals[type] ?? 0, totals[type], "item/category total");
  const gross = TYPES.reduce((sum, type) => sum + totals[type], 0);
  if (!(gross > 0)) throw new Error(`${KEY}: no positive reserves`);
  reconcile(gross, readValue(assets), "gross assets");
  reconcile(gross, readValue(byAccount.FBO_TRUST), "FBO account");
  const summary = data.summary;
  reconcile(totals.CASH, amount(summary.fboTrustUsdTotal), "FBO cash");
  reconcile(totals.TREASURY_BILLS + totals.REPURCHASE_AGREEMENTS, amount(summary.fboTrustSecuritiesTotal), "FBO securities");
  for (const key of ["liquidityFundDueAdminAccount", "liquidityAccountNetFmv", "liquidityFundUsdTotal", "liquidityFundSecuritiesTotal"] as const) {
    if (amount(summary[key]) !== 0) throw new Error(`${KEY}: liquidity fund requires scope review`);
  }
  const adminPayable = amount(summary.fboTrustDueAdminAccount);
  const net = gross - adminPayable;
  if (net < 0) throw new Error(`${KEY}: administrative payable exceeds gross assets`);
  reconcile(net, amount(summary.trustAccountNetFmv), "net FBO reserves");
  reconcile(net, amount(summary.totalHedge), "total net reserves");
  const seenChains = new Set<string>();
  let chainSupply = 0;
  for (const row of liability.breakdown) {
    const expectedAddress = row.chain === "solana" ? SOLANA_TOKEN : EVM_TOKEN;
    const addressMatches = row.chain === "solana" ? row.address === expectedAddress : row.address.toLowerCase() === expectedAddress;
    if (!Object.prototype.hasOwnProperty.call(CHAINS, row.chain) || seenChains.has(row.chain) || !addressMatches) {
      throw new Error(`${KEY}: duplicate or unreviewed FRNT chain identity`);
    }
    seenChains.add(row.chain);
    chainSupply += readValue(row);
  }
  if (seenChains.size !== Object.keys(CHAINS).length) throw new Error(`${KEY}: incomplete FRNT liability census`);
  const supply = readValue(liability);
  if (!(supply > 0)) throw new Error(`${KEY}: no positive liability`);
  reconcile(chainSupply, supply, "chain liabilities");
  reconcile(supply, amount(summary.totalLiabilities), "summary liabilities");
  return {
    slices: TYPES.filter((type) => totals[type] > 0).map((type) => ({ ...CLASSIFICATION[type], pct: totals[type] / gross * 100 })),
    ...(net + 0.01 < supply ? { warnings: [reserveDegradedWarning("reserve-undercollateralized", "FRNT net FBO reserves are below the same-snapshot token liabilities")] } : {}),
    metadata: {
      ...verifiedFreshnessMetadata(Date.parse(data.createdAt) / 1000),
      totalReserveUsd: net,
      supplyUsd: supply,
      collateralizationRatio: net / supply,
      details: {
        sourceUrl: FRNT_LEDGERLENS_URL, dashboardUrl: "https://dashboard.ledgerlens.io/c/wystc",
        snapshotId: data._id, grossFboAssetsUsd: gross, administrativePayableUsd: adminPayable,
        liquidityFundUsd: 0, compositionScope: "gross-FBO-inventory-before-unallocated-administrative-payable",
        compositionEvidence: "supplemental-non-assured-dashboard", runtimeAssuranceVerification: false,
        netBackingCompositionAttribution: "withheld", liabilityChainCount: seenChains.size,
      },
    },
  };
}

export async function fetchFrntLedgerlensReserves(
  coin: ReserveAdapterCoin,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireJsonInput(config.inputs.primary, KEY);
  if (coin.id !== "frnt-wyoming" || input.url !== FRNT_LEDGERLENS_URL || (config.params && Object.keys(config.params).length > 0)) {
    throw new Error(`${KEY}: unexpected coin, input URL or params`);
  }
  return adaptFrntLedgerlens(await fetchJsonWithRetry<unknown>(input.url, signal, 12_000, ctx, {
    headers: { "x-tsr-serverFn": "true", Accept: "application/json" }, maxResponseBytes: 256_000,
  }));
}
