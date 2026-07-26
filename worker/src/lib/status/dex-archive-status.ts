import type { DexArchiveStatus } from "@shared/types/status";
import { loadDexArchiveFamilyStates } from "../../cron/dex-archive/store";

interface DexArchiveManifestSummaryRow {
  manifest_count: number;
  uploaded_manifest_count: number;
  verified_manifest_count: number;
  source_deleted_manifest_count: number;
  failed_manifest_count: number;
}

function releaseStage(
  familyStates: Awaited<ReturnType<typeof loadDexArchiveFamilyStates>>,
): DexArchiveStatus["releaseStage"] {
  const measured = familyStates.find((family) => family.family === "measured-execution");
  const liquidity = familyStates.find((family) => family.family === "liquidity");
  if (liquidity?.effectiveMode === "delete") return "liquidity-delete";
  if (liquidity?.effectiveMode === "shadow") return "liquidity-shadow";
  if (measured?.effectiveMode === "delete") return "measured-delete";
  if (measured?.effectiveMode === "shadow") return "measured-shadow";
  return "foundation";
}

export async function loadDexArchiveStatus(
  db: D1Database,
  checkedAt: number,
): Promise<DexArchiveStatus> {
  const [familyStates, manifests] = await Promise.all([
    loadDexArchiveFamilyStates(db),
    db
      .prepare(
        `SELECT
           COUNT(*) AS manifest_count,
           COUNT(uploaded_at) AS uploaded_manifest_count,
           COUNT(verified_at) AS verified_manifest_count,
           COUNT(source_deleted_at) AS source_deleted_manifest_count,
           COALESCE(SUM(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed_manifest_count
         FROM dex_archive_manifests`,
      )
      .first<DexArchiveManifestSummaryRow>(),
  ]);
  return {
    checkedAt,
    releaseStage: releaseStage(familyStates),
    objectSchemaVersion: 1,
    logicalRetentionDays: 30,
    lifecycleExpiryDays: 35,
    manifestRetentionDays: 90,
    maxObjectsPerInvocation: 12,
    normalReadDependsOnR2: false,
    manifestCount: manifests?.manifest_count ?? 0,
    uploadedManifestCount: manifests?.uploaded_manifest_count ?? 0,
    verifiedManifestCount: manifests?.verified_manifest_count ?? 0,
    sourceDeletedManifestCount: manifests?.source_deleted_manifest_count ?? 0,
    failedManifestCount: manifests?.failed_manifest_count ?? 0,
    familyStates,
  };
}
