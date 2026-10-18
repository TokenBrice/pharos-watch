import { computeAndStoreDepegResolverReview } from "../compute-depeg-resolver-review";
import { writeDepegResolverAssessments } from "../../lib/depeg-resolver-assessment-store";
import { parseJsonObject } from "../../lib/json-parse";
import type { DdrV2StoreContracts } from "../depeg-resolver-v2-contracts";
import type { DdrDiagnosticResponse } from "./types";
import { formatDdrrFailure } from "./utils";

export interface DepegResolverReviewArtifacts {
  assessmentWriteCount: number;
  reviewRows: number;
  reviewError: string | null;
  reviewDegraded: boolean;
  reviewDegradedReason: string | null;
}

export async function persistDepegResolverReviewArtifacts(
  db: D1Database,
  snapshot: DdrDiagnosticResponse,
  storeContracts: DdrV2StoreContracts,
  signal?: AbortSignal,
): Promise<DepegResolverReviewArtifacts> {
  let assessmentWriteCount = 0;
  let reviewRows = 0;
  let reviewDegraded = false;
  let reviewDegradedReason: string | null = null;

  try {
    assessmentWriteCount = await writeDepegResolverAssessments(db, snapshot);
    const reviewResult = await computeAndStoreDepegResolverReview(db, signal, { storeContracts });
    reviewRows = reviewResult.itemCount ?? 0;
    const metadata = parseJsonObject(reviewResult.metadata);
    if (!metadata || typeof metadata.degraded !== "boolean") {
      throw new Error("ddrr-review-metadata-unavailable");
    }
    reviewDegraded = metadata.degraded;
    reviewDegradedReason = reviewDegraded
      ? typeof metadata.degradedReason === "string" && metadata.degradedReason.trim()
        ? metadata.degradedReason
        : "ddrr-review-degraded"
      : null;
  } catch (error) {
    if (signal?.aborted) throw error;
    return {
      assessmentWriteCount,
      reviewRows,
      reviewError: formatDdrrFailure(error),
      reviewDegraded,
      reviewDegradedReason,
    };
  }

  return { assessmentWriteCount, reviewRows, reviewError: null, reviewDegraded, reviewDegradedReason };
}
