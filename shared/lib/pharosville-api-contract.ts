import type { ZodType } from "zod";
import { API_PATHS } from "./api-endpoints";
import { API_FRESHNESS_MAX_AGE_SEC } from "./api-freshness";
import { CRON_INTERVALS } from "./cron-jobs";
import { DATA_SURFACE_DESCRIPTORS } from "./data-surface-descriptors";
import {
  PHAROSVILLE_API_ENDPOINT_KEYS,
  type PharosVilleApiEndpointKey,
  type PharosVilleApiPayload,
} from "../types/pharosville";
import { ChainsResponseSchema } from "../types/chains";
import {
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
} from "../types/market";
import { ReportCardsResponseSchema } from "../types/report-cards";
import { StabilityIndexResponseSchema } from "../types/stability";

export interface PharosVilleApiEndpoint<K extends PharosVilleApiEndpointKey = PharosVilleApiEndpointKey> {
  key: K;
  path: string;
  schema: ZodType<PharosVilleApiPayload<K>>;
  metaMaxAgeSec: number;
  producerIntervalSec: number;
}

export const PHAROSVILLE_API_CONTRACT = {
  stablecoins: {
    key: "stablecoins",
    path: DATA_SURFACE_DESCRIPTORS.stablecoins.apiPath,
    schema: StablecoinListResponseSchema,
    metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stablecoins.endpointMaxAgeSec,
    producerIntervalSec: DATA_SURFACE_DESCRIPTORS.stablecoins.producerIntervalSec,
  },
  chains: {
    key: "chains",
    path: API_PATHS.chains(),
    schema: ChainsResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.chains,
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
  },
  stability: {
    key: "stability",
    path: API_PATHS.stabilityIndex(true),
    schema: StabilityIndexResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
    producerIntervalSec: CRON_INTERVALS["stability-index"],
  },
  pegSummary: {
    key: "pegSummary",
    path: API_PATHS.pegSummary(),
    schema: PegSummaryResponseSchema,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
    producerIntervalSec: CRON_INTERVALS["sync-stablecoins"],
  },
  stress: {
    key: "stress",
    path: DATA_SURFACE_DESCRIPTORS.stressSignals.apiPath,
    schema: StressSignalsAllResponseSchema,
    metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.stressSignals.endpointMaxAgeSec,
    producerIntervalSec: DATA_SURFACE_DESCRIPTORS.stressSignals.producerIntervalSec,
  },
  reportCards: {
    key: "reportCards",
    path: DATA_SURFACE_DESCRIPTORS.reportCards.apiPath,
    schema: ReportCardsResponseSchema,
    metaMaxAgeSec: DATA_SURFACE_DESCRIPTORS.reportCards.endpointMaxAgeSec,
    producerIntervalSec: DATA_SURFACE_DESCRIPTORS.reportCards.producerIntervalSec,
  },
} satisfies {
  [K in PharosVilleApiEndpointKey]: PharosVilleApiEndpoint<K>;
};

export const PHAROSVILLE_API_ENDPOINTS = PHAROSVILLE_API_ENDPOINT_KEYS.map(
  (key) => PHAROSVILLE_API_CONTRACT[key],
);
