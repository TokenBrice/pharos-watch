import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import {
  getMechanismArchetypeCtaNoun,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
import { SourceLinkList } from "@/components/stablecoin-detail/source-link-list";
import type { MechanismReviewView } from "@/lib/mechanism-review";

/**
 * The reviewed evidence behind the Backing pillar's mechanism component
 * scores: dated analyst prose and the sources it was measured against.
 *
 * Body only. The Backing pillar strip owns the provenance line ("Mechanism
 * reviewed <date> · N sources"), the `Review notes & sources (N)` fold this
 * renders inside, and the `#mechanism-review` anchor. Nothing here repeats
 * the date, the source count or a verdict.
 */
export function MechanismReviewPanel({ review }: { review: MechanismReviewView | null }) {
  if (review === null) return null;

  return (
    <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
      <p className="max-w-[75ch] whitespace-pre-line">{review.notes}</p>
      <SourceLinkList sources={review.sources} className="space-y-1.5" />
      {/* Light mode takes the darker sky step: frost-blue on the light card is
          about 2:1, below the 4.5:1 text minimum. */}
      <Link
        href={getMechanismExplainerPath(review.archetype)}
        className="pharos-focus-ring inline-flex items-center gap-1 rounded-sm font-medium text-sky-700 underline-offset-4 hover:underline dark:text-frost-blue"
      >
        How {getMechanismArchetypeCtaNoun(review.archetype)} stablecoins work
        <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
      </Link>
    </div>
  );
}
