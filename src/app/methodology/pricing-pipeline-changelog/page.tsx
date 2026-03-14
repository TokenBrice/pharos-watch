import {
  PRICING_PIPELINE_CHANGELOG,
  PRICING_PIPELINE_VERSION_LABEL,
} from "@shared/lib/pricing-pipeline-version";
import { createMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createMethodologyChangelogRoute({
  path: "/methodology/pricing-pipeline-changelog/",
  metadataTitle: "Pricing Pipeline Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Pricing Pipeline methodology, from v1.0 through ${PRICING_PIPELINE_VERSION_LABEL}. Every source addition and consensus algorithm revision documented.`,
  breadcrumbName: "Pricing Pipeline Changelog",
  title: "Pricing Pipeline Changelog",
  lead: (
    <>
      Full version history of Pricing Pipeline methodology decisions, from v1.0 to {PRICING_PIPELINE_VERSION_LABEL}.
    </>
  ),
  accentClass: "border-l-blue-500",
  entries: PRICING_PIPELINE_CHANGELOG,
  selectImpact: (entry) => entry.impact,
});

export const metadata = route.metadata;
export default route.Page;
