import candidatePolicyAsset from "../../data/safety-score-v9/methodology-policy-candidate-v1.json";
import { V9MethodologyPolicySchema } from "../../types/safety-score-v9";
import { deepFreeze } from "../../types/safety-score-v9-immutable";

// Schema refinements and calendar math cannot load the runtime policy/evidence
// graph. Validate their subsets with the same schema and authored policy source.
export const V9_CANDIDATE_RESERVE_BOUND_POLICY = deepFreeze({
  backing: V9MethodologyPolicySchema.shape.semantic.shape.backing.parse(candidatePolicyAsset.semantic.backing),
  reviewedResearchMaxAgeSec: V9MethodologyPolicySchema.shape.semantic.shape.evidence.shape.evidenceExpiry.shape.reviewedResearchMaxAgeSec.parse(
    candidatePolicyAsset.semantic.evidence.evidenceExpiry.reviewedResearchMaxAgeSec,
  ),
});
