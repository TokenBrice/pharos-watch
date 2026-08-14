import { z } from "zod";
import audxManifest from "../data/live-reserves/independent-assurance/audx.json";
import europManifest from "../data/live-reserves/independent-assurance/europ.json";
import usdgoManifest from "../data/live-reserves/independent-assurance/usdgo.json";
import xsgdManifest from "../data/live-reserves/independent-assurance/xsgd.json";
import xusdManifest from "../data/live-reserves/independent-assurance/xusd.json";

const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

const INDEPENDENT_ASSURANCE_PRODUCTS = [
  "PYUSD",
  "USDP",
  "USDG",
  "PAXG",
  "GUSD",
  "AUDX",
  "EUROP",
  "USDGO",
  "XSGD",
  "XUSD",
] as const;

export type IndependentAssuranceProduct = (typeof INDEPENDENT_ASSURANCE_PRODUCTS)[number];

const DecimalStringSchema = z.string().regex(DECIMAL_PATTERN, "expected a decimal string");

const ReportAmountSchema = z
  .object({
    code: z.string().trim().min(1),
    label: z.string().trim().min(1),
    amount: DecimalStringSchema,
  })
  .strict();

const ReportAdjustmentSchema = z
  .object({
    code: z.string().trim().min(1),
    label: z.string().trim().min(1),
    amount: DecimalStringSchema,
    treatment: z.string().trim().min(1),
  })
  .strict();

export const IndependentAssuranceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    product: z.enum(INDEPENDENT_ASSURANCE_PRODUCTS),
    profile: z.string().trim().min(1),
    officialIndexUrl: z.string().url(),
    reportUrl: z.string().url(),
    reportSha256: z.string().regex(HASH_PATTERN),
    reportByteLength: z.number().int().positive(),
    reportDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reportAsOf: z.string().datetime({ offset: true }),
    reportTimeZone: z.string().trim().min(1),
    reportIssuedAt: z.string().datetime({ offset: true }).optional(),
    attestor: z.string().trim().min(1),
    engagement: z.string().trim().min(1),
    conclusion: z.enum(["unmodified", "unqualified", "nothing-came-to-attention"]),
    unit: z.enum(["USD", "EUR", "AUD", "SGD", "fine-troy-ounce"]),
    assets: z.array(ReportAmountSchema).min(1),
    liabilities: z.array(ReportAmountSchema).min(1),
    adjustments: z.array(ReportAdjustmentSchema).optional(),
    reportedAssetTotal: DecimalStringSchema,
    computedAssetTotal: DecimalStringSchema,
    reportedLiabilityTotal: DecimalStringSchema,
    extraction: z
      .object({
        tool: z.string().trim().min(1),
        parserVersion: z.string().trim().min(1),
        normalizedTextSha256: z.string().regex(HASH_PATTERN),
        pageCount: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type IndependentAssuranceManifest = z.infer<typeof IndependentAssuranceManifestSchema>;

const MANIFESTS: Partial<Record<IndependentAssuranceProduct, IndependentAssuranceManifest>> = {
  AUDX: IndependentAssuranceManifestSchema.parse(audxManifest),
  EUROP: IndependentAssuranceManifestSchema.parse(europManifest),
  USDGO: IndependentAssuranceManifestSchema.parse(usdgoManifest),
  XSGD: IndependentAssuranceManifestSchema.parse(xsgdManifest),
  XUSD: IndependentAssuranceManifestSchema.parse(xusdManifest),
};

export function getIndependentAssuranceManifest(product: IndependentAssuranceProduct): IndependentAssuranceManifest {
  const manifest = MANIFESTS[product];
  if (!manifest) {
    throw new Error(`independent-assurance: no reviewed manifest is registered for ${product}`);
  }
  return manifest;
}

interface DecimalValue {
  units: bigint;
  scale: number;
}

function parseDecimal(value: string, label: string): DecimalValue {
  if (!DECIMAL_PATTERN.test(value)) {
    throw new Error(`independent-assurance: ${label} is not a decimal string`);
  }

  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const scale = fraction.length;
  const units = BigInt(`${whole}${fraction}` || "0") * (negative ? -1n : 1n);
  return { units, scale };
}

function alignDecimals(left: DecimalValue, right: DecimalValue): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.units * 10n ** BigInt(scale - left.scale),
    right.units * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function decimalSum(values: readonly string[], label: string): string {
  let total: DecimalValue = { units: 0n, scale: 0 };
  for (const value of values) {
    const parsed = parseDecimal(value, label);
    const [left, right, scale] = alignDecimals(total, parsed);
    total = { units: left + right, scale };
  }
  return decimalString(total);
}

function decimalString(value: DecimalValue): string {
  const negative = value.units < 0n;
  const absolute = (negative ? -value.units : value.units).toString().padStart(value.scale + 1, "0");
  if (value.scale === 0) return `${negative ? "-" : ""}${absolute}`;
  const splitAt = absolute.length - value.scale;
  const whole = absolute.slice(0, splitAt);
  const fraction = absolute.slice(splitAt).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function decimalDifference(left: string, right: string): string {
  const parsedLeft = parseDecimal(left, "left amount");
  const parsedRight = parseDecimal(right, "right amount");
  const [alignedLeft, alignedRight, scale] = alignDecimals(parsedLeft, parsedRight);
  return decimalString({ units: alignedLeft - alignedRight, scale }).replace("-", "");
}

function decimalToNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`independent-assurance: ${label} is not a non-negative finite amount`);
  }
  return parsed;
}

function compareDecimal(left: string, right: string): number {
  const parsedLeft = parseDecimal(left, "left amount");
  const parsedRight = parseDecimal(right, "right amount");
  const [alignedLeft, alignedRight] = alignDecimals(parsedLeft, parsedRight);
  return alignedLeft < alignedRight ? -1 : alignedLeft > alignedRight ? 1 : 0;
}

export interface IndependentAssuranceReconciliationOptions {
  reportedAssetTotalTolerance?: {
    absolute: string;
    relativePpm: number;
  };
  reportedLiabilityTotalTolerance?: {
    absolute: string;
    relativePpm: number;
  };
}

export interface IndependentAssuranceReconciliation {
  computedAssetTotal: string;
  liabilityTotal: string;
  collateralizationRatio: number;
  reportedAssetDifference: string;
  reportedAssetDifferencePpm: number;
  reportedLiabilityDifference: string;
  reportedLiabilityDifferencePpm: number;
}

export function reconcileIndependentAssuranceManifest(
  manifest: IndependentAssuranceManifest,
  options?: IndependentAssuranceReconciliationOptions,
): IndependentAssuranceReconciliation {
  const assetAmounts = manifest.assets.map((row) => {
    const amount = parseDecimal(row.amount, `asset ${row.code}`);
    if (amount.units < 0n) {
      throw new Error(`independent-assurance: asset ${row.code} cannot be negative`);
    }
    return row.amount;
  });
  const liabilityAmounts = manifest.liabilities.map((row) => {
    const amount = parseDecimal(row.amount, `liability ${row.code}`);
    if (amount.units <= 0n) {
      throw new Error(`independent-assurance: liability ${row.code} must be positive`);
    }
    return row.amount;
  });
  const computedAssetTotal = decimalSum(assetAmounts, "asset total");
  const liabilityTotal = decimalSum(liabilityAmounts, "liability total");

  if (compareDecimal(computedAssetTotal, manifest.computedAssetTotal) !== 0) {
    throw new Error(
      `independent-assurance: computed asset total ${computedAssetTotal} does not match manifest ${manifest.computedAssetTotal}`,
    );
  }
  const reportedLiabilityDifference = decimalDifference(manifest.reportedLiabilityTotal, liabilityTotal);
  const reportedLiabilityDifferencePpm =
    (decimalToNumber(reportedLiabilityDifference, "reported liability difference") /
      decimalToNumber(manifest.reportedLiabilityTotal, "reported liability total")) *
    1_000_000;
  const liabilityTolerance = options?.reportedLiabilityTotalTolerance;
  if (!liabilityTolerance && compareDecimal(reportedLiabilityDifference, "0") !== 0) {
    throw new Error(
      `independent-assurance: liability total ${liabilityTotal} does not match manifest ${manifest.reportedLiabilityTotal}`,
    );
  }
  if (liabilityTolerance) {
    const absoluteExceeded = compareDecimal(reportedLiabilityDifference, liabilityTolerance.absolute) > 0;
    const relativeExceeded = reportedLiabilityDifferencePpm > liabilityTolerance.relativePpm;
    if (absoluteExceeded || relativeExceeded) {
      throw new Error(
        `independent-assurance: reported liability total differs by ${reportedLiabilityDifference} (${reportedLiabilityDifferencePpm.toFixed(3)} ppm)`,
      );
    }
  }
  if (compareDecimal(computedAssetTotal, liabilityTotal) < 0) {
    throw new Error(
      `independent-assurance: reserve assets ${computedAssetTotal} are below liabilities ${liabilityTotal}`,
    );
  }

  const reportedAssetDifference = decimalDifference(manifest.reportedAssetTotal, computedAssetTotal);
  const reportedAssetDifferencePpm =
    (decimalToNumber(reportedAssetDifference, "reported asset difference") /
      decimalToNumber(manifest.reportedAssetTotal, "reported asset total")) *
    1_000_000;
  const tolerance = options?.reportedAssetTotalTolerance;
  if (tolerance) {
    const absoluteExceeded = compareDecimal(reportedAssetDifference, tolerance.absolute) > 0;
    const relativeExceeded = reportedAssetDifferencePpm > tolerance.relativePpm;
    if (absoluteExceeded || relativeExceeded) {
      throw new Error(
        `independent-assurance: reported asset total differs by ${reportedAssetDifference} (${reportedAssetDifferencePpm.toFixed(3)} ppm)`,
      );
    }
  } else if (compareDecimal(reportedAssetDifference, "0") !== 0) {
    throw new Error(
      `independent-assurance: reported asset total ${manifest.reportedAssetTotal} does not match computed total ${computedAssetTotal}`,
    );
  }

  return {
    computedAssetTotal,
    liabilityTotal,
    collateralizationRatio:
      decimalToNumber(computedAssetTotal, "computed asset total") /
      decimalToNumber(liabilityTotal, "liability total"),
    reportedAssetDifference,
    reportedAssetDifferencePpm,
    reportedLiabilityDifference,
    reportedLiabilityDifferencePpm,
  };
}

export function independentAssuranceSourceTimestamp(manifest: IndependentAssuranceManifest): number {
  const timestampMs = Date.parse(manifest.reportAsOf);
  if (!Number.isFinite(timestampMs)) {
    throw new Error(`independent-assurance: reportAsOf is invalid for ${manifest.product}`);
  }
  if (manifest.reportAsOf.slice(0, 10) !== manifest.reportDate) {
    throw new Error(
      `independent-assurance: reportAsOf date ${manifest.reportAsOf.slice(0, 10)} does not match reportDate ${manifest.reportDate}`,
    );
  }
  return Math.floor(timestampMs / 1_000);
}
