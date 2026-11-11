import * as methodologyVersions from "@shared/lib/methodology-versions/constants";
import { METHODOLOGY_LANES } from "@shared/lib/methodology-versions/metadata.mts";
import { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, SAFETY_SCORE_METHODOLOGY_VERSION_LABEL } from "@shared/lib/methodology-versions/constants";
// Preserve specialized history validation alongside the lightweight labels.
import "@shared/lib/methodology-versions/depeg-resolver";
import "@shared/lib/methodology-versions/mint-authority";

export interface MethodologyManifestEntry {
  readonly key: string;
  readonly doc: string;
  readonly changelogDirectory: string;
  readonly versionFile: string;
  readonly expectedLabel: string;
}

export const METHODOLOGY_MANIFEST: readonly MethodologyManifestEntry[] = METHODOLOGY_LANES.flatMap((lane) =>
  lane.documents.map(({ key, doc }) => ({
    key,
    doc,
    changelogDirectory: lane.changelogDirectory,
    versionFile: lane.versionFile,
    expectedLabel: methodologyVersions[lane.versionLabelExport],
  })),
);

export { DEPEG_DEWS_METHODOLOGY_VERSION_LABEL, SAFETY_SCORE_METHODOLOGY_VERSION_LABEL };
