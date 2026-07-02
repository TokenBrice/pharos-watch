import Link from "next/link";
import { buildLiveCompareUrl } from "@/lib/compare-links";

interface TaxonomyNextCheckCtaProps {
  shortLabel: string;
  topCoinIds: readonly string[];
  /** Closing noun for the guidance line, e.g. "currency bucket", "backing model". */
  bucketNoun: string;
}

/** "Next Check" hand-off band shared by every stablecoin taxonomy facet:
 *  compare the cohort leaders, then set up alerts before depending on it. */
export function TaxonomyNextCheckCta({ shortLabel, topCoinIds, bucketNoun }: TaxonomyNextCheckCtaProps) {
  return (
    <section className="pharos-subtle-band">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <p className="pharos-kicker">Next Check</p>
          <p className="max-w-3xl text-sm leading-relaxed text-muted-foreground">
            Compare the leading {shortLabel} stablecoins, then use alerts for peg stress and safety-grade changes
            before you depend on one {bucketNoun}.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {topCoinIds.length >= 2 ? (
            <Link
              href={buildLiveCompareUrl(topCoinIds)}
              className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full border border-border/60 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-accent sm:min-h-9"
            >
              Compare leaders
            </Link>
          ) : null}
          <Link
            href="/pharoswatchbot/#bot"
            className="pharos-focus-ring inline-flex min-h-11 items-center rounded-full bg-primary px-3 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 sm:min-h-9"
          >
            Set up alerts
          </Link>
        </div>
      </div>
    </section>
  );
}
