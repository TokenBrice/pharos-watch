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
    expect(rows.find((r) => r.key === "reserve-access:origin:freeze")!.value).toContain("unquantified");
    expect(rows.find((r) => r.key === "reserve-access-coverage")!.label).toBe("Reserve-access coverage");
    for (const row of rows) {
      expect(row.label).not.toContain("(diagnostic)");
      expect(row.value).not.toContain("not additive");
    }
    expect(rows.find((r) => r.key === "freezeExposure")!.value).toBe("Upstream");
  });
  it("names the acting chain in reader text and never prints the internal authority key", () => {
    const card = makeV9Card();
    card.accessPosture.freezeLookthrough = evaluateV9AccessLookthrough(makeAccessGraph());
    const rows = buildSafetyScoreV9AccessRows(card);
    const authorityRow = rows.find((r) => r.key === "reserve-access:origin:freeze")!;
    expect(authorityRow.value).toContain("Ethereum");
    for (const row of rows) {
      expect(row.label).not.toContain("origin:freeze");
      expect(row.value).not.toContain("origin:freeze");
    }
  });
  it("merges authorities that read the same into one row with a count, and unresolved branches by reason", () => {
    const card = makeV9Card();
    const summary = evaluateV9AccessLookthrough(makeAccessGraph())!;
    const [authority] = summary.authorities;
    const [branch] = summary.unresolved.length > 0 ? summary.unresolved : [{ branchKey: "b0", nodeKey: "n0", reason: "scope-unreconciled" as const, responsibility: "issuer-undisclosed" as const }];
    card.accessPosture.freezeLookthrough = {
      ...summary,
      authorities: [authority!, { ...authority!, authorityKey: "second" }, { ...authority!, authorityKey: "third" }],
      unresolved: [
        { ...branch!, branchKey: "b1", reason: "scope-unreconciled" },
        { ...branch!, branchKey: "b2", reason: "scope-unreconciled" },
        { ...branch!, branchKey: "b3", reason: "issuer-undisclosed" },
      ],
    };
    const rows = buildSafetyScoreV9AccessRows(card);
    const authorityRows = rows.filter((r) => r.key.startsWith("reserve-access:"));
    expect(authorityRows).toHaveLength(1);
    expect(authorityRows[0]!.value).toMatch(/^Ethereum ×3 · /);
    const gapRows = rows.filter((r) => r.key.startsWith("reserve-access-gap:")).map((r) => r.value);
    expect(gapRows).toEqual(["Reserve-access scope unreconciled ×2", "Issuer has not disclosed this branch"]);
  });
  it("shows a measured zero remainder separately from absent historical look-through", () => {
    const card = makeV9Card();
    expect(buildSafetyScoreV9AccessRows(card).some((r) => r.key === "reserve-access-unknown")).toBe(false);
    card.accessPosture.freezeLookthrough = evaluateV9AccessLookthrough(makeAccessGraph());
    expect(buildSafetyScoreV9AccessRows(card).find((r) => r.key === "reserve-access-unknown")!.value).toBe("0.0%");
  });
});
