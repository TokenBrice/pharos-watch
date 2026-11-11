import type { YieldRanking } from "@shared/types/yield";
import type { YieldRankingSummary } from "@shared/types/yield-summary";
import type { YieldSourceDepthLens, YieldSourcePosture } from "@/lib/yield-source-risk";

export type YieldWorkbenchRanking = YieldRanking | YieldRankingSummary;

export type YieldExportRow = YieldWorkbenchRanking & {
  sourceDepthLens: YieldSourceDepthLens;
  sourcePosture: YieldSourcePosture;
};
