import { z } from "zod";

const ETHENA_STATUS_URL = "https://app.ethena.fi/api/collateralization/status";
const ETHENA_POR_URL = "https://app.ethena.fi/api/por";
const STATUS_MAX_AGE_MS = 12 * 60 * 60 * 1_000;
const POR_MAX_AGE_MS = 10 * 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export const EthenaCollateralizationStatusSchema = z
  .object({
    timestamp: z.string().min(1),
    totalBackingAssetsInUsd: z.number().finite().positive(),
    totalReserveFundInUsd: z.number().finite().nonnegative(),
    totalTokenSupplyInUsd: z.number().finite().positive(),
  })
  .strip();

const PorAuditorSchema = z
  .object({
    name: z.string().trim().min(1),
    is_confirmed: z.boolean(),
  })
  .strip();

const PorReportSchema = z
  .object({
    auditors: z.array(PorAuditorSchema).min(1),
    date: z.string().datetime(),
    deltaNeutral: z.boolean(),
    overCollateralized: z.boolean(),
  })
  .strip();

export const EthenaProofOfReservesSchema = z
  .object({
    lastUpdatedAt: z.string().datetime(),
    reports: z.array(PorReportSchema).min(1),
  })
  .strip();

const CheckSchema = z
  .object({
    id: z.string().min(1),
    status: z.literal("pass"),
    detail: z.string().min(1),
  })
  .strict();

export const ProtocolApiMechanismMeasurementSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("protocol-api-mechanism-measurement"),
    assetId: z.literal("usde-ethena"),
    archetype: z.literal("synthetic-delta-neutral"),
    capturedAt: z.string().datetime(),
    observations: z
      .object({
        collateralizationStatus: z
          .object({
            url: z.literal(ETHENA_STATUS_URL),
            observedAt: z.string().datetime(),
            payload: EthenaCollateralizationStatusSchema,
          })
          .strict(),
        proofOfReserves: z
          .object({
            url: z.literal(ETHENA_POR_URL),
            observedAt: z.string().datetime(),
            payload: EthenaProofOfReservesSchema,
          })
          .strict(),
      })
      .strict(),
    derived: z
      .object({
        collateralizationRatio: z.number().finite().positive(),
        latestPorReportAt: z.string().datetime(),
        deltaNeutralAttested: z.boolean(),
        overCollateralizedAttested: z.boolean(),
        confirmedAuditors: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    metrics: z
      .object({
        hedgeCoverageRatio: z.null(),
        liquidationCapacityUsd: z.null(),
        marginBufferPct: z.number().finite().nonnegative(),
        lossAbsorptionShare: z.number().finite().nonnegative(),
      })
      .strict(),
    checks: z.array(CheckSchema).min(4),
    tool: z
      .object({
        name: z.literal("measure-protocol-api-mechanism-metrics"),
        version: z.literal("1"),
      })
      .strict(),
  })
  .strict();

export type ProtocolApiMechanismMeasurement = z.infer<typeof ProtocolApiMechanismMeasurementSchema>;

export interface EthenaProtocolApiInput {
  collateralizationStatus: unknown;
  proofOfReserves: unknown;
  capturedAt?: Date;
}

function isAsciiDigits(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
}

function parseEthenaTimestamp(value: string): string {
  if (!value.endsWith(" UTC")) throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  const parts = value.slice(0, -4).split(" ");
  if (parts.length !== 2) throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  const [date, timeWithFraction] = parts as [string, string];
  const timeParts = timeWithFraction.split(".");
  if (timeParts.length > 2) throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  const [time, fraction = ""] = timeParts;
  const validDate = date.length === 10 && date[4] === "-" && date[7] === "-" && isAsciiDigits(date.replaceAll("-", ""));
  const validTime = time.length === 8 && time[2] === ":" && time[5] === ":" && isAsciiDigits(time.replaceAll(":", ""));
  if (!validDate || !validTime || (timeParts.length === 2 && !isAsciiDigits(fraction))) {
    throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  }
  const milliseconds = fraction.slice(0, 3).padEnd(3, "0");
  const parsed = new Date(`${date}T${time}.${milliseconds}Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== `${date}T${time}`) {
    throw new Error(`Invalid Ethena collateralization timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function assertFresh(label: string, observedAt: string, capturedAt: Date, maxAgeMs: number): void {
  const observedMs = Date.parse(observedAt);
  const capturedMs = capturedAt.getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(capturedMs)) throw new Error(`${label} has an invalid timestamp`);
  if (observedMs > capturedMs + FUTURE_TOLERANCE_MS) throw new Error(`${label} timestamp is in the future`);
  if (capturedMs - observedMs > maxAgeMs) throw new Error(`${label} is stale`);
}

function round(value: number, places = 6): number {
  return Number(value.toFixed(places));
}

export function buildEthenaProtocolApiMeasurement(input: EthenaProtocolApiInput): ProtocolApiMechanismMeasurement {
  const capturedAt = input.capturedAt ?? new Date();
  const status = EthenaCollateralizationStatusSchema.parse(input.collateralizationStatus);
  const por = EthenaProofOfReservesSchema.parse(input.proofOfReserves);
  const statusObservedAt = parseEthenaTimestamp(status.timestamp);
  const porObservedAt = new Date(por.lastUpdatedAt).toISOString();
  assertFresh("Ethena collateralization status", statusObservedAt, capturedAt, STATUS_MAX_AGE_MS);
  assertFresh("Ethena proof of reserves", porObservedAt, capturedAt, POR_MAX_AGE_MS);

  const latestReport = [...por.reports].sort((left, right) => Date.parse(right.date) - Date.parse(left.date))[0]!;
  if (latestReport.date !== por.lastUpdatedAt) {
    throw new Error("Ethena proof-of-reserves lastUpdatedAt does not match the latest report");
  }
  const confirmedAuditors = latestReport.auditors
    .filter((auditor) => auditor.is_confirmed)
    .map((auditor) => auditor.name)
    .sort();
  if (confirmedAuditors.length === 0) throw new Error("Ethena proof-of-reserves report has no confirmed auditor");

  const collateralizationRatio = status.totalBackingAssetsInUsd / status.totalTokenSupplyInUsd;
  if (collateralizationRatio < 0.5 || collateralizationRatio > 2) {
    throw new Error(`Ethena collateralization ratio is implausible: ${collateralizationRatio}`);
  }
  const marginBufferPct = Math.max(0, (collateralizationRatio - 1) * 100);
  const lossAbsorptionShare = status.totalReserveFundInUsd / status.totalTokenSupplyInUsd;
  if (lossAbsorptionShare > 1) throw new Error(`Ethena reserve-fund share is implausible: ${lossAbsorptionShare}`);

  return ProtocolApiMechanismMeasurementSchema.parse({
    schemaVersion: 1,
    kind: "protocol-api-mechanism-measurement",
    assetId: "usde-ethena",
    archetype: "synthetic-delta-neutral",
    capturedAt: capturedAt.toISOString(),
    observations: {
      collateralizationStatus: {
        url: ETHENA_STATUS_URL,
        observedAt: statusObservedAt,
        payload: status,
      },
      proofOfReserves: {
        url: ETHENA_POR_URL,
        observedAt: porObservedAt,
        payload: por,
      },
    },
    derived: {
      collateralizationRatio: round(collateralizationRatio, 9),
      latestPorReportAt: latestReport.date,
      deltaNeutralAttested: latestReport.deltaNeutral,
      overCollateralizedAttested: latestReport.overCollateralized,
      confirmedAuditors,
    },
    metrics: {
      // The PoR report attests delta neutrality but does not publish a
      // quantitative position ratio that can support a coverage measurement.
      hedgeCoverageRatio: null,
      // USDe has no protocol liquidation API or CDP liquidation surface.
      liquidationCapacityUsd: null,
      marginBufferPct: round(marginBufferPct),
      lossAbsorptionShare: round(lossAbsorptionShare),
    },
    checks: [
      { id: "status.fresh", status: "pass", detail: `collateralization status observed at ${statusObservedAt}` },
      { id: "por.fresh", status: "pass", detail: `proof of reserves observed at ${porObservedAt}` },
      {
        id: "por.confirmed-auditors",
        status: "pass",
        detail: `latest report confirmed by ${confirmedAuditors.join(", ")}`,
      },
      {
        id: "ratios.plausible",
        status: "pass",
        detail: "collateralization is within 0.5x-2x and reserve-fund share is at most 1x supply",
      },
    ],
    tool: { name: "measure-protocol-api-mechanism-metrics", version: "1" },
  });
}

export const ETHENA_PROTOCOL_API_URLS = {
  collateralizationStatus: ETHENA_STATUS_URL,
  proofOfReserves: ETHENA_POR_URL,
} as const;
