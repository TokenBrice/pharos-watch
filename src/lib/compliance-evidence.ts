import { loadClientStablecoinDetail } from "@shared/lib/stablecoins/client-detail";
import type { StablecoinLink } from "@shared/types";
import type { GeniusComplianceProfile } from "@shared/types/stablecoin-client-meta";

export interface GeniusComplianceEvidence {
  notes?: string;
  applicabilitySummary?: string;
  foreignExceptionSummary?: string;
  negativeEvidenceSummary?: string;
  negativeEvidenceSourcesChecked: string[];
  reviewer?: string;
  reviewedAt?: string;
  references: StablecoinLink[];
}

function buildGeniusComplianceEvidence(genius: GeniusComplianceProfile): GeniusComplianceEvidence {
  return {
    notes: genius.notes,
    applicabilitySummary: genius.applicabilityBasis?.summary,
    foreignExceptionSummary: genius.foreignExceptionEvidence?.summary,
    negativeEvidenceSummary: genius.negativeEvidenceReview?.summary,
    negativeEvidenceSourcesChecked: genius.negativeEvidenceReview?.sourcesChecked ?? [],
    reviewer: genius.reviewer,
    reviewedAt: genius.reviewedAt,
    references: collectGeniusReferences(genius),
  };
}

// Successful loads and in-flight requests survive fold unmounts for this session.
const geniusEvidenceById = new Map<string, Promise<GeniusComplianceEvidence>>();

export function loadGeniusComplianceEvidence(id: string): Promise<GeniusComplianceEvidence> {
  const cached = geniusEvidenceById.get(id);
  if (cached) return cached;
  const pending = loadClientStablecoinDetail(id)
    .then((detail) => {
      if (!detail?.genius) throw new Error(`GENIUS evidence unavailable for ${id}`);
      return buildGeniusComplianceEvidence(detail.genius);
    })
    .catch((error: unknown) => {
      geniusEvidenceById.delete(id);
      throw error;
    });
  geniusEvidenceById.set(id, pending);
  return pending;
}

function collectGeniusReferences(genius: GeniusComplianceProfile): StablecoinLink[] {
  const references = [
    ...(genius.references ?? []),
    ...(genius.applicabilityBasis?.references ?? []),
    ...(genius.foreignExceptionEvidence?.references ?? []),
    ...(genius.negativeEvidenceReview?.references ?? []),
  ];
  const seen = new Set<string>();
  const deduped: StablecoinLink[] = [];
  for (const reference of references) {
    const key = `${reference.label}:${reference.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({ label: reference.label, url: reference.url });
  }
  return deduped;
}
