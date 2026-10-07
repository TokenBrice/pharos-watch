import Link from "next/link";
import { ArrowUpRight, ExternalLink } from "lucide-react";
import {
  getMechanismArchetypeCtaNoun,
  getMechanismExplainerPath,
} from "@shared/lib/classification";
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
      <ul className="space-y-1.5">
        {review.sources.map((source) => (
          <li key={`${source.label}:${source.url}`} className="flex min-w-0 gap-2">
            <ExternalLink className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
            <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              className="pharos-focus-ring min-w-0 break-words rounded-sm underline underline-offset-2 transition-colors hover:text-foreground motion-reduce:transition-none"
            >
              {source.label}
            </a>
          </li>
        ))}
      </ul>
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
