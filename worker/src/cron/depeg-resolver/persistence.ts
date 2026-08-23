import { computeAndStoreDepegResolverReview } from "../compute-depeg-resolver-review";
import { writeDepegResolverAssessments } from "../../lib/depeg-resolver-assessment-store";
import { writeDepegResolverSnapshot } from "../../lib/depeg-resolver-snapshot-cache";
import type { DdrV2StoreContracts } from "../depeg-resolver-v2-contracts";
import type { DdrResponse } from "@shared/types/depeg-resolver";
import type { DdrDiagnosticResponse } from "./types";
import { formatDdrrFailure } from "./utils";

export async function persistDepegResolverSnapshot(
  db: D1Database,
  snapshot: DdrResponse,
): Promise<void> {
  await writeDepegResolverSnapshot(db, snapshot);
}

export async function persistDepegResolverReviewArtifacts(
  db: D1Database,
  snapshot: DdrDiagnosticResponse,
  storeContracts: DdrV2StoreContracts,
  signal?: AbortSignal,
): Promise<{ assessmentWriteCount: number; reviewRows: number; reviewError: string | null }> {
  let assessmentWriteCount = 0;
  let reviewRows = 0;

  try {
    assessmentWriteCount = await writeDepegResolverAssessments(db, snapshot);
    const reviewResult = await computeAndStoreDepegResolverReview(db, signal, { storeContracts });
    reviewRows = reviewResult.itemCount ?? 0;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      assessmentWriteCount,
      reviewRows,
      reviewError: formatDdrrFailure(error),
    };
  }

  return { assessmentWriteCount, reviewRows, reviewError: null };
}
