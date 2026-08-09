import {
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/methodology-versions/depeg-resolver";
import { buildMethodologyEnvelope } from "./api-utils";

export function buildDdrMethodologyEnvelope(asOf: number) {
  return buildMethodologyEnvelope({
    version: DDR_METHODOLOGY_VERSION,
    versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    currentVersion: DDR_METHODOLOGY_VERSION,
    currentVersionLabel: DDR_METHODOLOGY_VERSION_LABEL,
    changelogPath: DDR_METHODOLOGY_CHANGELOG_PATH,
    asOf,
  });
}
