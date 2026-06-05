import { PRICING_PIPELINE_V1 } from "../../data/methodology-changelogs/pricing-pipeline/v1";
import { PRICING_PIPELINE_V2 } from "../../data/methodology-changelogs/pricing-pipeline/v2";
import { PRICING_PIPELINE_V3 } from "../../data/methodology-changelogs/pricing-pipeline/v3";
import { PRICING_PIPELINE_V4 } from "../../data/methodology-changelogs/pricing-pipeline/v4";
import { PRICING_PIPELINE_V5 } from "../../data/methodology-changelogs/pricing-pipeline/v5";
import { PRICING_PIPELINE_V6 } from "../../data/methodology-changelogs/pricing-pipeline/v6";
import { createMethodologyVersion } from "./base";

const pricing = createMethodologyVersion({
  currentVersion: "6.11",
  changelogPath: "/methodology/pricing-pipeline-changelog/",
  changelog: [
    ...PRICING_PIPELINE_V6,
    ...PRICING_PIPELINE_V5,
    ...PRICING_PIPELINE_V4,
    ...PRICING_PIPELINE_V3,
    ...PRICING_PIPELINE_V2,
    ...PRICING_PIPELINE_V1,
  ],
});

/** Canonical Pricing Pipeline methodology version (no "v" prefix). */
export const PRICING_PIPELINE_VERSION = pricing.currentVersion;

/** Display-ready Pricing Pipeline methodology version (with "v" prefix). */
export const PRICING_PIPELINE_VERSION_LABEL = pricing.versionLabel;

/** Public changelog route for Pricing Pipeline methodology history. */
export const PRICING_PIPELINE_CHANGELOG_PATH = pricing.changelogPath;

/** Reconstructed changelog data. */
export const PRICING_PIPELINE_CHANGELOG = pricing.changelog;

/** Resolve Pricing Pipeline methodology version active at a given Unix timestamp (seconds). */
export const getPricingPipelineVersionAt = pricing.getVersionAt;
