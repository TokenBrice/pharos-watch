import {
  PRICING_PIPELINE_CHANGELOG,
  PRICING_PIPELINE_VERSION_LABEL,
} from "@shared/lib/pricing-pipeline-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/pricing-pipeline-changelog/",
  metadataTitle: "Pricing Pipeline Changelog - Version History",
  metadataDescription:
    `Full version history of the Pharos Pricing Pipeline methodology, from v1.0 through ${PRICING_PIPELINE_VERSION_LABEL}. Every source addition and consensus algorithm revision documented.`,
  breadcrumbName: "Pricing Pipeline Changelog",
  title: "Pricing Pipeline Changelog",
  leadSubject: "Pricing Pipeline",
  versionLabel: PRICING_PIPELINE_VERSION_LABEL,
  entries: PRICING_PIPELINE_CHANGELOG,
  citation: { id: "pricing-pipeline", versionLabel: PRICING_PIPELINE_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
