import {
  FRONTEND_API_QUERY_BASE_REGISTRY,
  type FrontendApiQueryBaseDescriptor,
} from "@/lib/api-query-base-registry";

export interface FrontendApiQueryDescriptor<_T> extends FrontendApiQueryBaseDescriptor {
  schema?: undefined;
}

const base = FRONTEND_API_QUERY_BASE_REGISTRY;

export const FRONTEND_API_QUERY_RUNTIME_REGISTRY = {
  stablecoins: base.stablecoins,
  dexLiquidity: base.dexLiquidity,
  pegSummary: base.pegSummary,
  reportCards: base.reportCards,
  stabilityIndex: base.stabilityIndex,
  stressSignals: base.stressSignals,
} as const satisfies Record<string, FrontendApiQueryDescriptor<unknown>>;
