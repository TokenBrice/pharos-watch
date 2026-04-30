import { describe, expect, it } from "vitest";
import { ChainsResponseSchema } from "../chains";
import {
  PegSummaryResponseSchema,
  StablecoinListResponseSchema,
  StressSignalsAllResponseSchema,
} from "../market";
import { PHAROSVILLE_API_CONTRACT_VERSION, PHAROSVILLE_API_ENDPOINT_KEYS, PharosVilleApiPayloadsSchema } from "../pharosville";
import { ReportCardsResponseSchema } from "../report-cards";
import { StabilityIndexResponseSchema } from "../stability";

describe("PharosVille shared payload contract", () => {
  it("pins the endpoint key set and version", () => {
    expect(PHAROSVILLE_API_CONTRACT_VERSION).toBe(1);
    expect(PHAROSVILLE_API_ENDPOINT_KEYS).toEqual([
      "stablecoins",
      "chains",
      "stability",
      "pegSummary",
      "stress",
      "reportCards",
    ]);
  });

  it("bundles the six existing endpoint schemas without creating a new API shape", () => {
    expect(PharosVilleApiPayloadsSchema.shape.stablecoins).toBe(StablecoinListResponseSchema);
    expect(PharosVilleApiPayloadsSchema.shape.chains).toBe(ChainsResponseSchema);
    expect(PharosVilleApiPayloadsSchema.shape.stability).toBe(StabilityIndexResponseSchema);
    expect(PharosVilleApiPayloadsSchema.shape.pegSummary).toBe(PegSummaryResponseSchema);
    expect(PharosVilleApiPayloadsSchema.shape.stress).toBe(StressSignalsAllResponseSchema);
    expect(PharosVilleApiPayloadsSchema.shape.reportCards).toBe(ReportCardsResponseSchema);
  });
});
