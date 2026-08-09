import { AdminMutationError, type AdminMutationResult } from "@/lib/admin-access";
import { RequestFailure } from "@/lib/request";

/**
 * The one certainty rule for a failed admin mutation (WS8.5).
 *
 * Both admin write lanes — `AdminActionExecutionProvider` (catalog actions) and
 * `useAdminMutationIntents` (bespoke JSON-body mutations) — used to carry their
 * own byte-identical copy of `isExecutionUnknownBody` and a
 * character-for-character equivalent `isActiveIdempotencyConflict`. That is a
 * correctness contract, not styling: `"unknown"` means *the write may already
 * have landed*, so the UI must offer "retry the same idempotency key" rather
 * than "try again", and must never present the operation as safely undone.
 *
 * Keep the predicates conservative — every branch below must resolve to
 * `"unknown"` whenever the request's fate is not provable from the response.
 */
export type AdminMutationCertainty = "unknown" | "failed";

/** The worker replies with this body when it cannot prove the write's fate. */
function isExecutionUnknownBody(data: unknown): boolean {
  return Boolean(
    data && typeof data === "object" && "error" in data && (data as { error?: unknown }).error === "execution_unknown",
  );
}

/**
 * A 409 that names *this* execution's own idempotency reservation: the first
 * attempt is still in flight (or lost its reservation mid-write), so the write
 * may well complete. A 409 for a *different* key is an ordinary conflict.
 */
function isActiveIdempotencyConflict(result: AdminMutationResult<unknown>, idempotencyKey: string): boolean {
  if (result.status !== 409) return false;
  const errorMessage =
    result.data &&
    typeof result.data === "object" &&
    "error" in result.data &&
    typeof (result.data as { error?: unknown }).error === "string"
      ? (result.data as { error: string }).error.toLowerCase()
      : "";
  const isReservationOrOwnershipLoss =
    errorMessage.includes("idempotency key is currently reserved") ||
    errorMessage.includes("idempotency reservation ownership was lost");
  const identifiesSameExecution = result.idempotentReplay === true || result.idempotencyKey === idempotencyKey;
  return isReservationOrOwnershipLoss && identifiesSameExecution;
}

/**
 * Classify a thrown admin-mutation failure as `"unknown"` (write may have
 * landed) or `"failed"` (write provably did not land).
 *
 * @param idempotencyKey the key the caller sent, used to tell "my own
 *   reservation is still active" apart from an unrelated conflict.
 */
export function classifyAdminMutationFailure(error: unknown, idempotencyKey: string): AdminMutationCertainty {
  if (error instanceof AdminMutationError) {
    return isExecutionUnknownBody(error.result.data) ||
      isActiveIdempotencyConflict(error.result, idempotencyKey) ||
      error.result.executionCertainty?.trim().toLowerCase() === "unknown" ||
      error.result.status >= 500
      ? "unknown"
      : "failed";
  }

  // A transport failure never proves the request did not reach the origin.
  return error instanceof RequestFailure &&
    (error.kind === "network" || error.kind === "timeout" || error.kind === "aborted")
    ? "unknown"
    : "failed";
}
