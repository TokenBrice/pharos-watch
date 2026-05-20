import {
  PSI_METHODOLOGY_CHANGELOG,
  PSI_METHODOLOGY_VERSION_LABEL,
} from "@shared/lib/stability-index-version";
import { createStandardMethodologyChangelogRoute } from "../changelog-route-factory";

const route = createStandardMethodologyChangelogRoute({
  path: "/methodology/stability-index-changelog/",
  metadataTitle: "Stability Index Changelog — Version History",
  metadataDescription:
    `Full version history of the Pharos Stability Index methodology, from v1.0 through ${PSI_METHODOLOGY_VERSION_LABEL}. Every formula, cap, and component revision documented.`,
  breadcrumbName: "Stability Index Changelog",
  title: "Stability Index Changelog",
  leadSubject: "PSI",
  versionLabel: PSI_METHODOLOGY_VERSION_LABEL,
  accentClass: "border-l-cyan-500",
  entries: PSI_METHODOLOGY_CHANGELOG,
  citation: { id: "psi", versionLabel: PSI_METHODOLOGY_VERSION_LABEL, pdfKey: "stability-index" },
});

export const metadata = route.metadata;
export default route.Page;
