import {
  DDR_METHODOLOGY_CHANGELOG,
  DDR_METHODOLOGY_CHANGELOG_PATH,
  DDR_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/depeg-resolver-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: DDR_METHODOLOGY_CHANGELOG_PATH,
  metadataTitle: "Depeg Duration Resolver Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Depeg Duration Resolver methodology, from v1.0 through ${DDR_METHODOLOGY_VERSION_LABEL}. Every resolution-rubric, stratification, and support-gate revision documented.`,
  breadcrumbName: "Depeg Duration Resolver Changelog",
  title: "Depeg Duration Resolver Changelog",
  leadSubject: "DDR",
  versionLabel: DDR_METHODOLOGY_VERSION_LABEL,
  entries: DDR_METHODOLOGY_CHANGELOG,
  citation: { id: "depeg-resolver", versionLabel: DDR_METHODOLOGY_VERSION_LABEL },
});

export const metadata = route.metadata;
export default route.Page;
