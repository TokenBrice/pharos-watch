export interface OperatorWatchEvidenceCondition {
  id: string;
  label?: string;
  active: boolean;
  /** This condition's evidence could not be measured this run: keep its prior state. */
  unknown?: boolean;
}

/**
 * Operator conditions share the producer transition state. Producer keys are
 * bare job names; every other section prefixes its key with `<section>:` so a
 * condition that disappears (a recovered detail write, a released hold) is
 * reported as recovered instead of silently dropped.
 */
export interface OperatorWatchCondition {
  section: OperatorWatchSection;
  /** Stable identity within the section (job name, coin id, rule name). */
  id: string;
  /** Operator-facing detail; defaults to `id`. */
  label?: string;
  active: boolean;
  /** This condition's evidence could not be read this run: keep its prior state. */
  unknown?: boolean;
}

export type OperatorWatchSection = "producer" | "detail-write" | "dependency" | "safety-publication" | "supply" | "canary" | "probe" | "fx-rates" | "daily-lane" | "producer-quality" | "psi-daily-coverage" | "blacklist-config" | "mint-burn-config";
