import Link from "next/link";
import { ArrowLeftRight } from "lucide-react";
import { AlertsHeaderLink } from "@/components/alerts-header-link";
import { Button } from "@/components/ui/button";
import { buildStaticCompareHref } from "@/lib/compare-links";

interface TaxonomyHeaderActionsProps {
  shortLabel: string;
  topCoinIds: readonly string[];
  /** Closing noun for the alerts description, e.g. "currency bucket", "backing model". */
  bucketNoun: string;
}

/** Instrument-header actions shared by every stablecoin taxonomy facet:
 *  compare the cohort leaders, then set up alerts before depending on it. */
export function TaxonomyHeaderActions({ shortLabel, topCoinIds, bucketNoun }: TaxonomyHeaderActionsProps) {
  return (
    <>
      {topCoinIds.length >= 2 ? (
        <Button
          asChild
          variant="outline"
          size="sm"
          className="min-h-11 rounded-full px-4 lg:min-h-9 lg:rounded-md"
        >
          <Link href={buildStaticCompareHref(topCoinIds)} aria-label={`Compare the leading ${shortLabel} stablecoins`}>
            <ArrowLeftRight aria-hidden="true" />
            <span>Compare leaders</span>
          </Link>
        </Button>
      ) : null}
      <AlertsHeaderLink
        href="/pharoswatchbot/#bot"
        description={`peg stress and safety-grade changes before you depend on one ${bucketNoun}`}
      />
    </>
  );
}
