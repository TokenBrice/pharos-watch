/**
 * Discriminated union describing the outcome of an external provider fetch.
 *
 * Distinguishes success states that should close a circuit breaker
 * (transport succeeded, even if no data was returned, or the provider
 * deliberately blocked us) from upstream transport failures that should
 * count against the breaker.
 */
export type FetcherOutcome<T> =
  | { kind: "ok"; value: T; partial?: boolean }
  | { kind: "no-data"; value: T }
  | { kind: "blocked"; value: T }
  | { kind: "upstream-error"; value: T; reason: string };

/**
 * Maps an outcome to a boolean for `recordOutcome(db, source, success)`.
 * `ok`, `no-data`, and `blocked` all count as breaker-success: transport
 * worked (or was deliberately refused) so hammering further will not help.
 */
export function isSuccessfulOutcome<T>(outcome: FetcherOutcome<T>): boolean {
  return outcome.kind === "ok" || outcome.kind === "no-data" || outcome.kind === "blocked";
}
