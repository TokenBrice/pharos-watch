import { MethodologyDetails } from "../../methodology-shared";
import { SafetyScoresDimensionDetails } from "./safety-scores-dimension-details";
import { SafetyScoresScoringDetails } from "./safety-scores-scoring-details";

export function SafetyScoresTechnicalDetails() {
  return (
    <MethodologyDetails summary="Legacy V8.17 compatibility details: dimensions, formulas, thresholds, and caveats">
      <SafetyScoresScoringDetails />
      <SafetyScoresDimensionDetails />
    </MethodologyDetails>
  );
}
