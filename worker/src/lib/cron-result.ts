import type { CronResult } from "./cron-logger";

export type CronMetadataPrimitive = string | number | boolean | null;

export type CronMetadataValue =
  | CronMetadataPrimitive
  | CronMetadataValue[]
  | { [key: string]: CronMetadataValue };

export type CronMetadataRecord = Record<string, CronMetadataValue>;

export interface StructuredCronResult<TMetadata extends CronMetadataRecord = CronMetadataRecord>
  extends Omit<CronResult, "metadata"> {
  metadata?: TMetadata;
}

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
