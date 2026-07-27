import type {
  ReportCardsV9CurrentResponse,
  V9PublicationHoldReason,
} from "@shared/types/report-cards-v9";

function describeHoldReason(reason: V9PublicationHoldReason): string {
  if (reason.code === "coverage-floor-failed") {
    return `Coverage floor failed for ${reason.floorIds.join(", ")}.`;
  }
  if (reason.code === "assessment-failed") {
    return "The latest ratings update could not be verified.";
  }
  if (reason.code === "producer-failed-downgrade" || reason.code === "producer-failed-nr") {
    return `${reason.assetId}: ${reason.reasonCode}.`;
  }
  return `${reason.code.replaceAll("-", " ")}.`;
}

export function SafetyScoreV9StatusNotice({
  response,
}: {
  response: ReportCardsV9CurrentResponse | null | undefined;
}) {
  if (response?.publicationHealth?.status !== "held") return null;

  const heldSince = response.publicationHealth.heldSinceSec;
  const reasons = response.publicationHealth.reasons.map(describeHoldReason).join(" ");

  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-800 dark:text-amber-300"
      role="status"
    >
      Ratings held at the last verified snapshot
      {heldSince ? ` since ${new Date(heldSince * 1000).toLocaleString()}` : ""}.
      {reasons ? ` ${reasons}` : ""}
    </div>
  );
}
