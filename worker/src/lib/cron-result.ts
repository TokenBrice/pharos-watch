import type { CronResult } from "./cron-run-contract";
import { confirmedCronOutputAt } from "./cron-output";
import { parseJsonObject } from "./json-parse";

export const COMMITTED_PUBLICATION_ABORT_REASON = "aborted-after-publication";

/** Only an opted-in, confirmed publication survives cancellation; completion stays degraded. */
export function retainCommittedCronResultAfterAbort(result: CronResult | void): CronResult | undefined {
  if (result?.abortResultPolicy !== "preserve-committed-publication"
    || !result.productivity?.productive || !result.productivity.publications?.length) return undefined;
  const metadata = parseJsonObject(result.metadata);
  if (confirmedCronOutputAt(result, metadata, Math.floor(Date.now() / 1000)) == null) return undefined;
  return {
    ...result,
    status: "degraded",
    metadata: JSON.stringify({
      ...metadata,
      ...(metadata?.reason && metadata.reason !== COMMITTED_PUBLICATION_ABORT_REASON ? { preAbortReason: metadata.reason } : {}),
      reason: COMMITTED_PUBLICATION_ABORT_REASON,
    }),
  };
}

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

function serializeCronMetadata<TMetadata extends CronMetadataRecord>(
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
