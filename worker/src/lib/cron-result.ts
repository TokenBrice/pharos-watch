import type { CronResult } from "./cron-logger";

export type CronMetadataPrimitive = string | number | boolean | null;

export type CronMetadataValue =
  | CronMetadataPrimitive
  | readonly CronMetadataValue[]
  | { [key: string]: CronMetadataValue };

export type CronMetadataRecord = Record<string, CronMetadataValue>;

export type StructuredCronResult<TMetadata extends CronMetadataRecord = CronMetadataRecord> =
  Omit<CronResult, "metadata" | "status"> & (
    | { status?: "ok"; metadata?: TMetadata }
    | { status: Exclude<NonNullable<CronResult["status"]>, "ok">; metadata: TMetadata & { reason: string } }
  );

export function serializeCronMetadata<TMetadata extends CronMetadataRecord>(
  metadata: TMetadata | null | undefined,
): string | undefined {
  if (!metadata) return undefined;
  return JSON.stringify(metadata);
}

export function createCronResult<TMetadata extends CronMetadataRecord>(
  result: StructuredCronResult<TMetadata>,
): CronResult {
  return {
    ...result,
    metadata: serializeCronMetadata(result.metadata),
  };
}

export function createNeutralSkippedCronResult(
  reason: string,
  metadata: CronMetadataRecord = {},
): CronResult {
  return createCronResult({
    itemCount: 0,
    status: "skipped_neutral",
    metadata: {
      ...metadata,
      reason,
    },
  });
}
