import { PRICING_PIPELINE_V1 } from "../../data/methodology-changelogs/pricing-pipeline/v1";
import { PRICING_PIPELINE_V2 } from "../../data/methodology-changelogs/pricing-pipeline/v2";
import { PRICING_PIPELINE_V3 } from "../../data/methodology-changelogs/pricing-pipeline/v3";
import { PRICING_PIPELINE_V4 } from "../../data/methodology-changelogs/pricing-pipeline/v4";
import { PRICING_PIPELINE_V5 } from "../../data/methodology-changelogs/pricing-pipeline/v5";
import { PRICING_PIPELINE_V6 } from "../../data/methodology-changelogs/pricing-pipeline/v6";
import { createMethodologyVersion } from "./base";
import {
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION,
} from "./constants";

const pricing = createMethodologyVersion({
  currentVersion: PRICING_PIPELINE_METHODOLOGY_VERSION,
  changelogPath: PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  changelog: [
    ...PRICING_PIPELINE_V6,
    ...PRICING_PIPELINE_V5,
    ...PRICING_PIPELINE_V4,
    ...PRICING_PIPELINE_V3,
    ...PRICING_PIPELINE_V2,
    ...PRICING_PIPELINE_V1,
  ],
});

export {
  PRICING_PIPELINE_METHODOLOGY_CHANGELOG_PATH,
  PRICING_PIPELINE_METHODOLOGY_VERSION,
  PRICING_PIPELINE_METHODOLOGY_VERSION_LABEL,
} from "./constants";

/** Reconstructed changelog data. */
export const PRICING_PIPELINE_METHODOLOGY_CHANGELOG = pricing.changelog;
