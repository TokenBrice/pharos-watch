import transferReviewOverlays from "@shared/data/safety-score-v9/transfer-review-overlays-v1.json";
import { CHAIN_META } from "@shared/lib/chains";
import { titleCaseSlug } from "@/lib/title-case-slug";

/**
 * Build-time extraction of the per-deployment transfer review behind the scored
 * access posture. Import this module only from server components: the overlay
 * file is ~240 KB and must never enter a client bundle — pages pass the slim
 * view object below as a prop instead, the same pattern as `mechanism-review.ts`.
 *
 * The Access posture panel publishes four enums with no citation. 263 of 335
 * rated assets read `Restrictable` there, which is the strongest claim on the
 * page and the least substantiated one. This view supplies the evidence: which
 * contract on which chain was inspected, what it showed, and the sources.
 */

export interface TransferReviewSource {
  label: string;
  url: string;
}

export interface TransferReviewDeployment {
  key: string;
  chainId: string;
  chainName: string;
  /** `canonical` is the home deployment; `material-bridge` is a bridged copy. */
  scope: string;
  scopeLabel: string;
  posture: string;
  postureLabel: string;
  evidence: string;
  sources: TransferReviewSource[];
}

export interface TransferReviewView {
  /** ISO date the deployments were inspected. */
  reviewedAt: string;
  deployments: TransferReviewDeployment[];
  /** True when the deployments do not all share one posture. */
  mixedPosture: boolean;
}

interface OverlayDeploymentShape {
  chainId: string;
  contractOrTokenId: string;
  scope: string;
  posture: string;
  evidence?: string;
  sources?: Array<{ label: string; url: string }>;
}

interface OverlayEntryShape {
  assetId: string;
  reviewedAt: string;
  deployments?: OverlayDeploymentShape[];
}

const POSTURE_LABELS: Record<string, string> = {
  permissionless: "Permissionless",
  restrictable: "Restrictable",
  permissioned: "Permissioned",
};

const SCOPE_LABELS: Record<string, string> = {
  canonical: "Canonical",
  "material-bridge": "Bridged",
  additional: "Additional",
};

const REVIEWS_BY_ASSET_ID: ReadonlyMap<string, OverlayEntryShape> = new Map(
  Object.values(transferReviewOverlays.reviews as unknown as Record<string, OverlayEntryShape>)
    .map((review) => [review.assetId, review]),
);

export function buildTransferReviewView(assetId: string): TransferReviewView | null {
  const review = REVIEWS_BY_ASSET_ID.get(assetId);
  if (!review) return null;

  const deployments: TransferReviewDeployment[] = [];
  for (const deployment of review.deployments ?? []) {
    const evidence = deployment.evidence?.trim();
    // Without the written finding there is nothing here the scored enum in the
    // panel above does not already say.
    if (!evidence) continue;
    deployments.push({
      key: `${deployment.chainId}:${deployment.contractOrTokenId}`,
      chainId: deployment.chainId,
      chainName: CHAIN_META[deployment.chainId]?.name ?? titleCaseSlug(deployment.chainId),
      scope: deployment.scope,
      scopeLabel: SCOPE_LABELS[deployment.scope] ?? titleCaseSlug(deployment.scope),
      posture: deployment.posture,
      postureLabel: POSTURE_LABELS[deployment.posture] ?? titleCaseSlug(deployment.posture),
      evidence,
      sources: (deployment.sources ?? []).filter((source) => source.label.trim() && source.url.trim()),
    });
  }

  if (deployments.length === 0) return null;

  // Canonical deployments first; a bridged copy with a different posture is the
  // interesting case, and it should read as a departure from the home chain.
  deployments.sort((left, right) =>
    Number(right.scope === "canonical") - Number(left.scope === "canonical")
    || left.chainName.localeCompare(right.chainName),
  );

  return {
    reviewedAt: review.reviewedAt,
    deployments,
    mixedPosture: new Set(deployments.map((deployment) => deployment.posture)).size > 1,
  };
}
