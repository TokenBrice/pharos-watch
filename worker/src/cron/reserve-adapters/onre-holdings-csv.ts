import type { ReserveSlice, StablecoinMeta } from "@shared/types/core";
import { parseLiveReserveAdapterParams } from "@shared/lib/live-reserve-adapters";
import type { LiveReservesConfig } from "@shared/types/live-reserves";
import type { AdapterContext, AdapterResult } from "./types";
import {
  freshnessMetadataFromTimestamp,
  fetchTextWithRetry,
  requireHtmlInput,
  slicesFromValues,
} from "./helpers";
import { reserveDegradedWarning, reserveInfoWarning } from "./warnings";

const ADAPTER_KEY = "onre-holdings-csv";
const REQUEST_TIMEOUT_MS = 15_000;

/** Amount-vs-declared-total reconciliation tolerance (relative). */
const AMOUNT_TOTAL_REL_TOLERANCE = 1e-6;
/** Allocation-sum-vs-100% tolerance (percentage points). */
const ALLOCATION_SUM_TOLERANCE_PCT = 0.01;
/** Total-vs-AUM reconciliation tolerance (relative). */
const TOTAL_AUM_REL_TOLERANCE = 1e-4;

interface OnReAssetRow {
  name: string;
  amountUsd: number;
  allocationPct: number;
}

export interface OnReSchedule {
  assetRows: OnReAssetRow[];
  declaredTotalUsd: number | null;
  declaredAumUsd: number | null;
  declaredAllocationSumPct: number | null;
  snapshotDateUnixSec: number | null;
  snapshotDateIso: string | null;
}

interface SliceMeta {
  sourceKey: string;
  name: string;
  risk: ReserveSlice["risk"];
  coinId?: string;
  depType?: ReserveSlice["depType"];
  assetClass?: ReserveSlice["assetClass"];
  issuerOrObligor?: string;
}

// Reviewed slice identity mirrors shared/data/stablecoins/domains/reserves/onyc-onre.json:
// the two sheet Treasury rows are combined, and the Kamino lending rows stay
// protocol positions of their upstream assets.
const SLICE_META: Record<string, SliceMeta> = {
  "t-bills": {
    sourceKey: "onre-holdings-csv:us-t-bills",
    name: "Short-term U.S. Treasury bills",
    risk: "very-low",
    assetClass: "treasury-bill",
    issuerOrObligor: "United States Treasury",
  },
  usdg: {
    sourceKey: "onre-holdings-csv:usdg",
    name: "USDG",
    risk: "low",
    coinId: "usdg-paxos",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "Paxos-issued Global Dollar (USDG)",
  },
  susds: {
    sourceKey: "onre-holdings-csv:susds",
    name: "sUSDS",
    risk: "low",
    coinId: "susds-sky",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "Sky Ecosystem sUSDS savings token",
  },
  "syrup-usdc": {
    sourceKey: "onre-holdings-csv:syrup-usdc",
    name: "syrupUSDC",
    risk: "medium",
    coinId: "syrupusdc-maple",
    depType: "collateral",
    assetClass: "protocol-position",
    issuerOrObligor: "Maple Finance syrupUSDC lending pool",
  },
  susde: {
    sourceKey: "onre-holdings-csv:susde",
    name: "sUSDe",
    risk: "high",
    coinId: "susde-ethena",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "Ethena sUSDe staked synthetic-dollar token",
  },
  uscc: {
    sourceKey: "onre-holdings-csv:uscc",
    name: "USCC",
    risk: "medium",
    assetClass: "fund-share",
    issuerOrObligor: "Superstate Crypto Carry Fund (USCC)",
  },
  "usdg-kamino-lending": {
    sourceKey: "onre-holdings-csv:usdg-kamino-lending",
    name: "USDG (Kamino lending)",
    risk: "medium",
    coinId: "usdg-paxos",
    depType: "collateral",
    assetClass: "protocol-position",
    issuerOrObligor: "Paxos-issued Global Dollar (USDG) supplied to Kamino lending markets on Solana",
  },
  "usdc-kamino-lending": {
    sourceKey: "onre-holdings-csv:usdc-kamino-lending",
    name: "USDC (Kamino lending)",
    risk: "medium",
    coinId: "usdc-circle",
    depType: "collateral",
    assetClass: "protocol-position",
    issuerOrObligor: "Circle Internet Financial (USDC) supplied to Kamino lending markets on Solana",
  },
  usyc: {
    sourceKey: "onre-holdings-csv:usyc",
    name: "USYC",
    risk: "low",
    coinId: "usyc-hashnote",
    depType: "collateral",
    assetClass: "fund-share",
    issuerOrObligor: "Hashnote International Short Duration Yield Fund Ltd.",
  },
  usdc: {
    sourceKey: "onre-holdings-csv:usdc",
    name: "USDC",
    risk: "low",
    coinId: "usdc-circle",
    depType: "collateral",
    assetClass: "stablecoin",
    issuerOrObligor: "Circle Internet Financial",
  },
  "usd-cash": {
    sourceKey: "onre-holdings-csv:usd-cash",
    name: "USD cash",
    risk: "very-low",
    assetClass: "cash",
    issuerOrObligor: "On Re SAC cash accounts; banking counterparties undisclosed",
  },
};

// Exact source-native asset labels from the Schedule of Assets sheet.
const ROW_TO_BUCKET: Record<string, string> = {
  "Short-Term US T-Bills": "t-bills",
  "Short-Term U.S. T-Bills": "t-bills",
  USDG: "usdg",
  sUSDS: "susds",
  syrupUSDC: "syrup-usdc",
  sUSDe: "susde",
  USCC: "uscc",
  "USDG (Lending)": "usdg-kamino-lending",
  "USDC (Lending)": "usdc-kamino-lending",
  USYC: "usyc",
  USDC: "usdc",
  USD: "usd-cash",
};

/** Strict quoted-CSV reader for the published sheet (RFC-4180 quoting). */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

function parseAmountUsd(value: string): number {
  const amount = Number(value.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`OnRe schedule amount is not a positive finite number: ${JSON.stringify(value)}`);
  }
  return amount;
}

function parseAllocationPct(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const allocation = Number(trimmed);
  if (!Number.isFinite(allocation) || allocation < 0) {
    throw new Error(`OnRe schedule allocation is not a non-negative finite number: ${JSON.stringify(value)}`);
  }
  return allocation;
}

function parseSnapshotDate(value: string): { unixSec: number; iso: string } | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  if (!Number.isFinite(timestamp)) return null;
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return { unixSec: Math.floor(timestamp / 1000), iso: date.toISOString().slice(0, 10) };
}

/**
 * Parses the published Schedule of Assets CSV into a typed schedule. The
 * snapshot/statement date rides in the header row next to a "Snapshot date"
 * label; when it is absent or unparseable the schedule carries no date and
 * freshness falls back to explicit unverified metadata.
 */
export function parseOnReSchedule(text: string): OnReSchedule {
  const rows = parseCsvRows(text);
  if (rows.length === 0) {
    throw new Error("OnRe schedule CSV is empty");
  }
  if ((rows[0]![0] ?? "").trim() !== "Asset") {
    throw new Error(`OnRe schedule CSV header missing (first cell ${JSON.stringify(rows[0]?.[0])})`);
  }

  let snapshotDateUnixSec: number | null = null;
  let snapshotDateIso: string | null = null;
  const header = rows[0]!;
  const dateLabelIndex = header.findIndex((cell) => cell.trim().toLowerCase() === "snapshot date");
  if (dateLabelIndex >= 0 && dateLabelIndex + 1 < header.length) {
    const parsed = parseSnapshotDate(header[dateLabelIndex + 1]!);
    if (parsed) {
      snapshotDateUnixSec = parsed.unixSec;
      snapshotDateIso = parsed.iso;
    }
  }

  const assetRows: OnReAssetRow[] = [];
  let declaredTotalUsd: number | null = null;
  let declaredAumUsd: number | null = null;
  let declaredAllocationSumPct: number | null = null;
  for (const row of rows.slice(1)) {
    const name = (row[0] ?? "").trim();
    if (name === "") continue;
    if (name === "Total") {
      if (row.length < 2 || (row[1] ?? "").trim() === "") {
        throw new Error("OnRe schedule Total row is missing its amount");
      }
      declaredTotalUsd = parseAmountUsd(row[1]!);
      declaredAllocationSumPct = parseAllocationPct(row[2] ?? "");
      continue;
    }
    if (name === "AUM") {
      if (row.length < 2 || (row[1] ?? "").trim() === "") {
        throw new Error("OnRe schedule AUM row is missing its amount");
      }
      declaredAumUsd = parseAmountUsd(row[1]!);
      continue;
    }
    if (row.length < 2 || (row[1] ?? "").trim() === "") {
      throw new Error(`OnRe schedule asset row ${JSON.stringify(name)} is missing its amount`);
    }
    assetRows.push({
      name,
      amountUsd: parseAmountUsd(row[1]!),
      allocationPct: parseAllocationPct(row[2] ?? "") ?? 0,
    });
  }

  return {
    assetRows,
    declaredTotalUsd,
    declaredAumUsd,
    declaredAllocationSumPct,
    snapshotDateUnixSec,
    snapshotDateIso,
  };
}

/**
 * Reconciles the schedule against its own declarations with tight tolerances
 * and publishes the known drift instead of hiding it:
 * - asset amounts must sum to the declared Total row (else the evidence is
 *   internally inconsistent and the attempt fails closed);
 * - an allocation column that does not sum to 100% and a Total that does not
 *   match the declared AUM both surface as degraded warnings carrying the
 *   exact drift, while weights are normalized to the declared total.
 */
export function adaptOnReSchedule(schedule: OnReSchedule): AdapterResult {
  if (schedule.declaredTotalUsd == null || schedule.declaredAumUsd == null) {
    throw new Error("OnRe schedule is missing its Total and/or AUM reconciliation rows");
  }
  const declaredTotal = schedule.declaredTotalUsd;
  const declaredAum = schedule.declaredAumUsd;
  if (schedule.assetRows.length === 0) {
    throw new Error("OnRe schedule contains no asset rows");
  }

  const amountSum = schedule.assetRows.reduce((sum, row) => sum + row.amountUsd, 0);
  if (Math.abs(amountSum - declaredTotal) / Math.max(1, declaredTotal) > AMOUNT_TOTAL_REL_TOLERANCE) {
    throw new Error(
      `OnRe schedule asset amounts sum to ${amountSum.toFixed(2)} but the declared Total is ${declaredTotal.toFixed(2)}`,
    );
  }

  const warnings: Awaited<AdapterResult>["warnings"] = [];
  const allocationSum = schedule.assetRows.reduce((sum, row) => sum + row.allocationPct, 0);
  if (Math.abs(allocationSum - 100) > ALLOCATION_SUM_TOLERANCE_PCT) {
    warnings.push(
      reserveDegradedWarning(
        "allocation-sum-drift",
        `OnRe schedule allocation column sums to ${allocationSum.toFixed(7)}% instead of 100%; `
        + "weights are normalized to the declared asset total.",
      ),
    );
  }
  const totalVsAumUsd = amountSum - declaredAum;
  const totalVsAumPct = (totalVsAumUsd / amountSum) * 100;
  if (Math.abs(totalVsAumUsd) / Math.max(1, amountSum) > TOTAL_AUM_REL_TOLERANCE) {
    warnings.push(
      reserveDegradedWarning(
        "total-aum-mismatch",
        `OnRe schedule Total $${amountSum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} `
        + `exceeds declared AUM $${declaredAum.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} `
        + `by $${totalVsAumUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} `
        + `(${totalVsAumPct.toFixed(4)}%); the unreconciled drift is published, not absorbed.`,
      ),
    );
  }

  const bucketValues = new Map<string, number>();
  let unmappedValueUsd = 0;
  for (const row of schedule.assetRows) {
    const bucket = ROW_TO_BUCKET[row.name];
    if (bucket) {
      bucketValues.set(bucket, (bucketValues.get(bucket) ?? 0) + row.amountUsd);
    } else {
      unmappedValueUsd += row.amountUsd;
    }
  }
  if (unmappedValueUsd > 0) {
    warnings.push(
      reserveInfoWarning(
        "unmapped-schedule-row",
        `OnRe schedule contains $${unmappedValueUsd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} `
        + "in asset rows outside the reviewed roster; they are published as an unclassified slice.",
      ),
    );
  }

  const values = Array.from(bucketValues.entries()).map(([bucket, value]) => {
    const meta = SLICE_META[bucket]!;
    return {
      value,
      sourceKey: meta.sourceKey,
      name: meta.name,
      risk: meta.risk,
      ...(meta.coinId ? { coinId: meta.coinId } : {}),
      ...(meta.depType ? { depType: meta.depType } : {}),
      ...(meta.assetClass ? { assetClass: meta.assetClass } : {}),
      ...(meta.issuerOrObligor ? { issuerOrObligor: meta.issuerOrObligor } : {}),
    };
  });
  if (unmappedValueUsd > 0) {
    values.push({
      value: unmappedValueUsd,
      sourceKey: "onre-holdings-csv:unmapped-schedule-rows",
      name: "Unreviewed Schedule of Assets rows",
      risk: "very-high",
      assetClass: "other",
      issuerOrObligor: "Unreviewed OnRe Schedule of Assets rows",
    });
  }

  const slices = slicesFromValues(values, 1);
  const unknownExposurePct = amountSum > 0 ? (unmappedValueUsd / amountSum) * 100 : 0;

  const details: Record<string, unknown> = {
    snapshotDateIso: schedule.snapshotDateIso,
    declaredTotalUsd: declaredTotal,
    declaredAumUsd: declaredAum,
    totalVsAumUsd,
    totalVsAumPct,
    declaredAllocationSumPct: schedule.declaredAllocationSumPct,
    allocationSumPct: allocationSum,
    perRow: schedule.assetRows.map((row) => ({
      name: row.name,
      amountUsd: row.amountUsd,
      declaredAllocationPct: row.allocationPct,
    })),
  };
  if (schedule.snapshotDateUnixSec != null) {
    details.freshnessSource = "issuer-snapshot-date";
  }

  const freshness = freshnessMetadataFromTimestamp(
    schedule.snapshotDateUnixSec,
    "onre-holdings-csv",
    "sheet header has no parseable snapshot date",
  );

  return {
    slices,
    warnings,
    metadata: {
      totalReserveUsd: amountSum,
      referenceNavUsd: declaredAum,
      ...(unknownExposurePct > 0 ? { unknownExposurePct } : {}),
      ...freshness,
      details: {
        ...("details" in freshness ? freshness.details : {}),
        ...details,
      },
    },
  };
}

export async function fetchOnreHoldingsCsvReserves(
  _coin: StablecoinMeta,
  config: LiveReservesConfig,
  signal: AbortSignal,
  ctx?: AdapterContext,
): Promise<AdapterResult> {
  const input = requireHtmlInput(config.inputs.primary, ADAPTER_KEY);
  parseLiveReserveAdapterParams(ADAPTER_KEY, config.params);
  const text = await fetchTextWithRetry(input.url, signal, REQUEST_TIMEOUT_MS, ctx);
  return adaptOnReSchedule(parseOnReSchedule(text));
}
