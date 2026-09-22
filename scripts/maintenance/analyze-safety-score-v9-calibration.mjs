import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  parseCalibrationArgs,
  readCalibrationInputs,
  serializeCalibrationReport,
} from "../lib/safety-score-v9-calibration-cli.mjs";
import {
  analyzeV9Calibration as buildV9CalibrationReport,
} from "../lib/safety-score-v9-calibration-report.mjs";
export { deriveCalibrationGradePolicy } from "../lib/safety-score-v9-calibration-core.mjs";
export {
  computeCalibrationBaseInputGenerationId,
  computeCalibrationCandidateId,
  computeCalibrationFactSetDigest,
  computeCalibrationIdentityDigest,
  computeCalibrationResultDigest,
} from "../lib/safety-score-v9-calibration-replay.mjs";
export {
  distributionGates,
  measuredAdverseFDrivers,
  summarizeDistribution,
} from "../lib/safety-score-v9-calibration-metrics.mjs";
export {
  captureMovements,
  evaluateRealACandidateChecks,
  projectScoreBearingCalibrationInput,
  qualifyingCompositeCards,
  repeatedRealAAssetIds,
} from "../lib/safety-score-v9-calibration-evidence.mjs";
export function analyzeV9Calibration(baseline, candidate, fridayEvidence = {}) {
  return buildV9CalibrationReport(baseline, candidate, fridayEvidence);
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const args = parseCalibrationArgs(process.argv.slice(2));
  if (args) {
    const { baseline, candidate, fridayEvidence } = readCalibrationInputs(
      args,
      (path) => readFileSync(path, "utf8"),
    );
    const serialized = serializeCalibrationReport(
      analyzeV9Calibration(baseline, candidate, fridayEvidence),
    );
    if (args.output) writeFileSync(args.output, serialized, "utf8");
    else process.stdout.write(serialized);
  }
}
