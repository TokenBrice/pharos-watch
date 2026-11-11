/** Cache identities shared with thin readers and the scheduler. */
export const SAFETY_SCORE_V9_CACHE_KEYS = {
  publication: "report-cards:v9",
  cohort: "report-cards:v9:cohort:v1",
  scoreIndex: "report-cards:v9:score-index",
  acceptedBaseline: "report-cards:v9:accepted-baseline:v1",
  lenderCollateral: "report-cards:v9:lender-collateral:v1",
  publicationHealth: "report-cards:v9:publication-health",
  publicationAttempt: "report-cards:v9:last-attempt",
  failedPublicationAttempt: "report-cards:v9:last-failed-attempt",
  publicMaterializationFailure: "report-cards:v9:public-materialization-failure",
} as const;

export const SAFETY_SCORE_V9_PUBLICATION_REPLAY_CACHE_KEY = "report-cards:v9:accepted-replay:v1";
export const SAFETY_SCORE_V9_PUBLICATION_REPLAY_BASE_CACHE_KEY = "report-cards:v9:accepted-replay-base:v1";
