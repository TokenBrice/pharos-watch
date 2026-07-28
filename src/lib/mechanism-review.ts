import mechanismReviewOverlays from "@shared/data/safety-score-v9/mechanism-review-overlays-v1.json";
import { MECHANISM_ARCHETYPE_VALUES } from "@shared/types";
import type { MechanismArchetype } from "@shared/types";

/**
 * Build-time extraction of the V9 mechanism review narrative. Import this module
 * only from server components: the overlay file is ~1 MB and must never enter a
 * client bundle — pages pass the slim view object below as a prop instead.
 *
 * Per-dimension quality ratings are deliberately not extracted. Those stay
 * internal (owner decision, 2026-07-28): publishing them would introduce a
 * public rating vocabulary, which is methodology-visible. The reviewed evidence
 * and its sources are not — they explain the mechanism component scores the
 * report card already publishes.
 */
export interface MechanismReviewSource {
  label: string;
  url: string;
}

export interface MechanismReviewView {
  archetype: MechanismArchetype;
  /** ISO date the evidence was pinned. */
  reviewedAt: string;
  /** Dated analyst prose measured against the sources below. */
  notes: string;
  sources: MechanismReviewSource[];
}

interface OverlayEntryShape {
  assetId: string;
  archetype: string;
  reviewedAt: string;
  notes?: string;
  sources?: Array<{ label: string; url: string }>;
}

const ARCHETYPES = new Set<string>(MECHANISM_ARCHETYPE_VALUES);

const OVERLAYS_BY_ASSET_ID: ReadonlyMap<string, OverlayEntryShape> = new Map(
  (mechanismReviewOverlays.overlays as unknown as OverlayEntryShape[]).map((overlay) => [overlay.assetId, overlay]),
);

export function buildMechanismReviewView(assetId: string): MechanismReviewView | null {
  const overlay = OVERLAYS_BY_ASSET_ID.get(assetId);
  if (!overlay || !ARCHETYPES.has(overlay.archetype)) return null;

  const notes = overlay.notes?.trim();
  const sources = (overlay.sources ?? []).filter((source) => source.label.trim() && source.url.trim());
  // The panel exists to show reviewed evidence; without prose or a citation
  // there is nothing to show that the score bars do not already say.
  if (!notes || sources.length === 0) return null;

  return {
    archetype: overlay.archetype as MechanismArchetype,
    reviewedAt: overlay.reviewedAt,
    notes,
    sources,
  };
}
