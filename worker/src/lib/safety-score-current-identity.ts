import { SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST } from "@shared/data/safety-score-v8/evaluation-build-manifest-v1";
import { SAFETY_SCORE_METHODOLOGY_VERSION } from "@shared/lib/safety-score-version";
import type { SafetyScoreV8PublicationIdentity } from "@shared/types/safety-score-publication";

/**
 * Validates the deployed V8 model attributes. Publication and base-input IDs
 * remain generation-specific and are checked by the compact-cache completeness
 * contract before this guard is reached.
 */
export function isCurrentSafetyScoreV8Identity(
  identity: SafetyScoreV8PublicationIdentity | null | undefined,
): identity is SafetyScoreV8PublicationIdentity {
  return identity?.model === "v8"
    && identity.schemaVersion === 1
    && identity.methodologyVersion === SAFETY_SCORE_METHODOLOGY_VERSION
    && identity.evaluationBuildDigest === SAFETY_SCORE_V8_EVALUATION_BUILD_DIGEST;
}
