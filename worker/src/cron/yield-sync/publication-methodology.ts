import {
  YIELD_METHODOLOGY_CHANGELOG_PATH,
  YIELD_METHODOLOGY_VERSION,
  YIELD_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/yield-methodology";
import { buildMethodologyEnvelope } from "../../lib/api-utils";

export function buildYieldMethodology(asOf: number) {
  return buildMethodologyEnvelope({
    version: YIELD_METHODOLOGY_VERSION,
    versionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    currentVersion: YIELD_METHODOLOGY_VERSION,
    currentVersionLabel: YIELD_METHODOLOGY_VERSION_LABEL,
    changelogPath: YIELD_METHODOLOGY_CHANGELOG_PATH,
    asOf,
  });
}
