import { describe, expect, it } from "vitest";
import { makeV9Card } from "@/test/fixtures/safety-score-v9";
import { buildSafetyScoreV9AccessRows } from "@/lib/stablecoin-safety-score-v9-presentation-access";
import { evaluateV9AccessLookthrough } from "@shared/lib/safety-score-v9/access-lookthrough";
import { makeAccessGraph } from "@shared/lib/__tests__/safety-score-v9-access-lookthrough.test-support";

describe("reserve-access diagnostic presentation", () => {
  it("keeps the unknown remainder visible alongside an upstream result and never formats null as zero", () => {
    const graph = makeAccessGraph(); graph.edges[0]!.weight = null;
    const card = makeV9Card();
    card.accessPosture.freezeExposure = "upstream";
    card.accessPosture.freezeLookthrough = evaluateV9AccessLookthrough(graph);
    const rows = buildSafetyScoreV9AccessRows(card);
    expect(rows.find((r) => r.key === "reserve-access-unknown")!.value).toBe("Unknown / unquantified");
    expect(rows.find((r) => r.key === "reserve-access:origin:freeze")!.value).toContain("Unquantified");
    expect(rows.find((r) => r.key === "reserve-access-coverage")!.label).toContain("diagnostic");
    expect(rows.find((r) => r.key === "freezeExposure")!.value).toBe("Upstream");
  });
  it("shows a measured zero remainder separately from absent historical look-through", () => {
    const card = makeV9Card();
    expect(buildSafetyScoreV9AccessRows(card).some((r) => r.key === "reserve-access-unknown")).toBe(false);
    card.accessPosture.freezeLookthrough = evaluateV9AccessLookthrough(makeAccessGraph());
    expect(buildSafetyScoreV9AccessRows(card).find((r) => r.key === "reserve-access-unknown")!.value).toBe("0.0%");
  });
});
