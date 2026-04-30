import { z } from "zod";
import { ChainsResponseSchema } from "./chains";
import {
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
} from "./market";
import { ReportCardsResponseSchema } from "./report-cards";
import { StabilityIndexResponseSchema } from "./stability";

export const PHAROSVILLE_API_CONTRACT_VERSION = 1;

export const PHAROSVILLE_API_ENDPOINT_KEYS = [
  "stablecoins",
  "chains",
  "stability",
  "pegSummary",
  "stress",
  "reportCards",
] as const;

export type PharosVilleApiEndpointKey = (typeof PHAROSVILLE_API_ENDPOINT_KEYS)[number];

export const PharosVilleApiPayloadsSchema = z.object({
  stablecoins: StablecoinListResponseSchema,
  chains: ChainsResponseSchema,
  stability: StabilityIndexResponseSchema,
  pegSummary: PegSummaryResponseSchema,
  stress: StressSignalsAllResponseSchema,
  reportCards: ReportCardsResponseSchema,
});

export type PharosVilleApiPayloads = z.infer<typeof PharosVilleApiPayloadsSchema>;
export type PharosVilleApiPayload<K extends PharosVilleApiEndpointKey> = PharosVilleApiPayloads[K];
