/**
 * Curated "How does X break?" dossier scenarios (`data/failure-scenarios.json`).
 * Each record is a hypothetical, maintainer-reviewed failure path. It never
 * feeds the Safety Score; a record only publishes once the maintainer approves
 * its exact content (see `review`).
 */

/** How strongly a claim is supported, kept separate from plausibility/severity. */
export type FailureScenarioEvidence = "verified-onchain" | "documented" | "inferred" | "unverified";

export type FailureScenarioStageKind =
  | "premise"
  | "authority-capture"
  | "governance"
  | "mint-or-upgrade"
  | "market-shock"
  | "counterparty-failure"
  | "redemption-blocked"
  | "holder-outcome";

export interface FailureScenarioTarget {
  label: string;
  address: `0x${string}`;
  chainId: number;
}

export interface FailureScenarioStage {
  id: string;
  kind: FailureScenarioStageKind;
  title: string;
  actor: string;
  /** Exact call or action; rendered monospace when `actionIsCode` is true. */
  action: string;
  actionIsCode?: boolean;
  targets?: FailureScenarioTarget[];
  /** Position on the scenario clock, e.g. "T+0", "T+7d". */
  elapsed: string;
  /** Duration or cost of this stage, e.g. "one transaction". */
  cost: string;
  /** The safeguard that is absent at this hop; rendered on the connector. */
  missingDefense?: string;
  explanation: string;
  evidence: FailureScenarioEvidence;
  sourceIds: string[];
}

export interface FailureScenarioWindow {
  label: string;
  /** Inclusive stage ids the window spans. */
  fromStageId: string;
  toStageId: string;
  duration: string;
  note: string;
}

export type FailureScenarioDefenderVerdict = "cannot-stop" | "partial" | "can-stop" | "unverified";

export interface FailureScenarioDefender {
  name: string;
  verdict: FailureScenarioDefenderVerdict;
  why: string;
  evidence: FailureScenarioEvidence;
  sourceIds: string[];
}

export type FailureScenarioFalsifierStatus = "not-met" | "met" | "unverified";

export interface FailureScenarioFalsifier {
  id: string;
  condition: string;
  status: FailureScenarioFalsifierStatus;
  checkedAtBlock?: number;
}

export interface FailureScenarioExposure {
  label: string;
  detail: string;
  evidence: FailureScenarioEvidence;
}

export interface FailureScenarioSource {
  id: string;
  label: string;
  url: `http${string}`;
  observedAt?: string;
  block?: number;
}

/** One way into the shared chain, e.g. "one operator key" vs "3 of 5 Safe signers". */
export interface FailureScenarioBranch {
  id: string;
  label: string;
  /** Short key/threshold label shown on the fork, e.g. "1 key", "3 of 5". */
  keys: string;
  /** Hypothetical precondition specific to this route. */
  premise: string;
  stages: FailureScenarioStage[];
}

/**
 * Alternative routes inserted after `afterStageId` in the trunk; every branch
 * rejoins the trunk at the next trunk stage.
 */
export interface FailureScenarioBranchPoint {
  afterStageId: string;
  branches: FailureScenarioBranch[];
}

/** Headline numbers for the at-a-glance strip. */
export interface FailureScenarioKeyFigure {
  value: string;
  label: string;
  evidence: FailureScenarioEvidence;
  sourceIds: string[];
}

export type FailureScenarioReview =
  | { status: "draft"; note?: string }
  | {
      status: "approved";
      reviewedBy: string;
      reviewedAt: string;
      /** sha256 of the canonical record without `review`; any later edit invalidates approval. */
      contentSha256: string;
    };

export interface FailureScenario {
  coinId: string;
  title: string;
  thesis: string;
  premise: string;
  /** Trunk stages; `branchPoint` splices alternative routes into it after `afterStageId`. */
  stages: FailureScenarioStage[];
  branchPoint?: FailureScenarioBranchPoint;
  keyFigures: FailureScenarioKeyFigure[];
  window?: FailureScenarioWindow;
  defenders: FailureScenarioDefender[];
  falsifiers: FailureScenarioFalsifier[];
  exposure: FailureScenarioExposure[];
  sources: FailureScenarioSource[];
  evidencePin: { chainId: number; block: number; observedAt: string };
  review: FailureScenarioReview;
}

export type FailureScenariosById = Record<string, FailureScenario>;
