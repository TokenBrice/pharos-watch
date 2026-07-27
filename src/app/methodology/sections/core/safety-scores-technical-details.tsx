import { MethodologyDetails } from "../../methodology-shared";
import { SafetyScoresDimensionDetails } from "./safety-scores-dimension-details";
import { SafetyScoresScoringDetails } from "./safety-scores-scoring-details";

export function SafetyScoresTechnicalDetails() {
  return (
    <MethodologyDetails summary="Historical V8.17 methodology: dimensions, formulas, thresholds, and caveats">
      <SafetyScoresScoringDetails />
      <SafetyScoresDimensionDetails />
    </MethodologyDetails>
  );
}
