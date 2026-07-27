import Link from "next/link";
import type { ReportCardsV9CurrentResponse } from "@shared/types/report-cards-v9";
import { describeDataCoverageHoldCauses } from "@/app/safety-scores/data-coverage-view-model";

/**
 * Compact held-publication notice for every surface other than `/safety-scores`,
 * which renders the full data-coverage module instead. Reason codes are never
 * printed raw: they are evaluator identifiers, not reader-facing copy.
 */
export function SafetyScoreV9StatusNotice({
  response,
}: {
  response: ReportCardsV9CurrentResponse | null | undefined;
}) {
  if (response?.publicationHealth?.status !== "held") return null;

  const heldSince = response.publicationHealth.heldSinceSec;
  const causes = describeDataCoverageHoldCauses(response.publicationHealth.reasons);

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
      role="status"
    >
      Ratings are held at the last verified snapshot
      {heldSince ? (
        <>
          {" "}since{" "}
          <time
            suppressHydrationWarning
            dateTime={new Date(heldSince * 1000).toISOString()}
          >
            {new Date(heldSince * 1000).toLocaleString()}
          </time>
        </>
      ) : null}
      , because some inputs are missing.
      {causes.length > 0 ? ` ${causes.join(" ")}` : ""}{" "}
      <Link href="/safety-scores/" className="pharos-focus-ring rounded-sm underline">
        See what data is missing
      </Link>
      .
    </div>
  );
}
