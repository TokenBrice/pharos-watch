import { makeWorkerReportCardsV9Response, makeWorkerV9Card } from "../../test-helpers/report-cards-v9";

/** Healthy publication for command-routing suites; unavailable paths use their own fixtures. */
export function makeTelegramSafetySnapshot() {
  return makeWorkerReportCardsV9Response({
    updatedAt: 1_700_000_000,
    cards: [makeWorkerV9Card({ id: "usdc-circle", grade: "A", score: 85 })],
  });
}
