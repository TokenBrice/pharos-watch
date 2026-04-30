import { describe, expect, it } from "vitest";
import { API_FRESHNESS_MAX_AGE_SEC } from "../api-freshness";
import { CRON_INTERVALS } from "../cron-jobs";
import {
  PHAROSVILLE_API_CONTRACT,
  PHAROSVILLE_API_ENDPOINTS,
} from "../pharosville-api-contract";
import { ChainsResponseSchema } from "../../types/chains";
import {
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
} from "../../types/market";
import { ReportCardsResponseSchema } from "../../types/report-cards";
import { StabilityIndexResponseSchema } from "../../types/stability";

describe("PHAROSVILLE_API_CONTRACT", () => {
  it("describes the exact API paths the split app consumes", () => {
    expect(PHAROSVILLE_API_ENDPOINTS.map((endpoint) => endpoint.key)).toEqual([
      "stablecoins",
      "chains",
      "stability",
      "pegSummary",
      "stress",
      "reportCards",
    ]);

    expect(Object.fromEntries(
      PHAROSVILLE_API_ENDPOINTS.map((endpoint) => [endpoint.key, endpoint.path]),
    )).toEqual({
      stablecoins: "/api/stablecoins",
      chains: "/api/chains",
      stability: "/api/stability-index?detail=true",
      pegSummary: "/api/peg-summary",
      stress: "/api/stress-signals",
      reportCards: "/api/report-cards",
    });
  });

  it("uses the shared endpoint schemas", () => {
    expect(PHAROSVILLE_API_CONTRACT.stablecoins.schema).toBe(StablecoinListResponseSchema);
    expect(PHAROSVILLE_API_CONTRACT.chains.schema).toBe(ChainsResponseSchema);
    expect(PHAROSVILLE_API_CONTRACT.stability.schema).toBe(StabilityIndexResponseSchema);
    expect(PHAROSVILLE_API_CONTRACT.pegSummary.schema).toBe(PegSummaryResponseSchema);
    expect(PHAROSVILLE_API_CONTRACT.stress.schema).toBe(StressSignalsAllResponseSchema);
    expect(PHAROSVILLE_API_CONTRACT.reportCards.schema).toBe(ReportCardsResponseSchema);
  });

  it("pins freshness and producer cadence budgets for the standalone proxy client", () => {
    expect(PHAROSVILLE_API_CONTRACT.stablecoins.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.stablecoins);
    expect(PHAROSVILLE_API_CONTRACT.chains.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.chains);
    expect(PHAROSVILLE_API_CONTRACT.stability.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.stabilityIndex);
    expect(PHAROSVILLE_API_CONTRACT.pegSummary.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.pegSummary);
    expect(PHAROSVILLE_API_CONTRACT.stress.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.stressSignals);
    expect(PHAROSVILLE_API_CONTRACT.reportCards.metaMaxAgeSec).toBe(API_FRESHNESS_MAX_AGE_SEC.reportCards);

    expect(PHAROSVILLE_API_CONTRACT.stablecoins.producerIntervalSec).toBe(CRON_INTERVALS["sync-stablecoins"]);
    expect(PHAROSVILLE_API_CONTRACT.chains.producerIntervalSec).toBe(CRON_INTERVALS["sync-stablecoins"]);
    expect(PHAROSVILLE_API_CONTRACT.stability.producerIntervalSec).toBe(CRON_INTERVALS["stability-index"]);
    expect(PHAROSVILLE_API_CONTRACT.pegSummary.producerIntervalSec).toBe(CRON_INTERVALS["sync-stablecoins"]);
    expect(PHAROSVILLE_API_CONTRACT.stress.producerIntervalSec).toBe(CRON_INTERVALS["compute-dews"]);
    expect(PHAROSVILLE_API_CONTRACT.reportCards.producerIntervalSec).toBe(CRON_INTERVALS["publish-report-card-cache"]);
  });
});
