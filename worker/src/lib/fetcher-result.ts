/** Outcome of an external provider fetch, discriminated for circuit-breaker accounting. */
export type FetcherOutcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "no-data"; value: T }
  | { kind: "blocked"; value: T }
  | { kind: "upstream-error"; value: T; reason: string };

export function isSuccessfulOutcome<T>(outcome: FetcherOutcome<T>): boolean {
  return outcome.kind === "ok" || outcome.kind === "no-data" || outcome.kind === "blocked";
}
