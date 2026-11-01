/** A transition condition contributed by an auxiliary operator-watch evidence reader. */
export interface OperatorWatchEvidenceCondition {
  id: string;
  label?: string;
  active: boolean;
  /** This condition's evidence could not be measured this run: keep its prior state. */
  unknown?: boolean;
}
