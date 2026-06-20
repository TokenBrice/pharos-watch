import { API_PATHS } from "@shared/lib/api-endpoints/paths";
import { API_FRESHNESS_MAX_AGE_SEC } from "@shared/lib/api-freshness";
import {
  CRON_15MIN,
  CRON_30MIN,
} from "@/lib/cron-intervals";

export interface FrontendApiQueryDescriptor<_T> {
  queryKey: readonly unknown[];
  path: string;
  producerIntervalMs: number;
  metaMaxAgeSec?: number;
  schema?: undefined;
}

export const FRONTEND_API_QUERY_RUNTIME_REGISTRY = {
  stablecoins: {
    queryKey: ["stablecoins"],
    path: API_PATHS.stablecoins(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stablecoins,
  },
  dexLiquidity: {
    queryKey: ["dex-liquidity"],
    path: API_PATHS.dexLiquidity(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.dexLiquidity,
  },
  pegSummary: {
    queryKey: ["peg-summary"],
    path: API_PATHS.pegSummary(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.pegSummary,
  },
  reportCards: {
    queryKey: ["report-cards"],
    path: API_PATHS.reportCards(),
    producerIntervalMs: CRON_15MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.reportCards,
  },
  stabilityIndex: {
    queryKey: ["stability-index"],
    path: API_PATHS.stabilityIndex(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stabilityIndex,
  },
  stressSignals: {
    queryKey: ["stress-signals"],
    path: API_PATHS.stressSignals(),
    producerIntervalMs: CRON_30MIN,
    metaMaxAgeSec: API_FRESHNESS_MAX_AGE_SEC.stressSignals,
  },
} as const;
