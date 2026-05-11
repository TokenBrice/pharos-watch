import { MethodologyDetails } from "../../methodology-shared";
import { SafetyScoresDimensionDetails } from "./safety-scores-dimension-details";
import { SafetyScoresScoringDetails } from "./safety-scores-scoring-details";

export function SafetyScoresTechnicalDetails() {
  return (
    <MethodologyDetails summary="Technical details: full pipeline, dimension formulas, thresholds, and caveats">
      <SafetyScoresScoringDetails />
      <SafetyScoresDimensionDetails />
    </MethodologyDetails>
  );
}
