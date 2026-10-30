import { REDEMPTION_BACKSTOP_METHODOLOGY_VERSION } from "@shared/lib/methodology-versions/constants";
import { V9_REASON_CODES } from "@shared/types/safety-score-v9";
import { describe, expect, it } from "vitest";
import {
  V9_MISSING_DATA_WORK_TYPES,
} from "../../lib/safety-score-v9-missing-data-work-types";
import { classifyV9CurationWorklistStream } from "../generate-safety-score-v9-missing-data-registry";
import { renderCurationWorklist } from "../generate-safety-score-v9-curation-worklist.mjs";

const agentProtocol = {
  claim: "Registry claim instruction.",
  collisionAvoidance: "Registry collision-avoidance instruction.",
  evidenceStandard: "Registry evidence-standard instruction.",
  verification: "Registry verification instruction.",
  editPolicy: "Registry edit-policy instruction.",
};

function bandFixture(reasons, missingItems) {
  const replay = {
    pipeline: {
      candidate: { cards: [{ id: "alpha", ratingStatus: "rated", grade: "B", score: 75 }] },
      evaluatedSet: {
        assets: [{
          assetId: "alpha",
          stressState: { exitPortfolio: { circulatingUsd: 1_000_000 } },
          scoreInput: {
            pillars: { backing: { reasons: [] }, exit: { reasons: [] }, control: { reasons } },
            peg: { reasons: [] },
            dependencyReasons: [],
          },
          backing: { archetype: "fiat-cash", contributions: [] },
        }],
      },
    },
  };
  const registry = {
    agentProtocol,
    summary: { stablecoinCount: 1, warnings: [] },
    stablecoins: [{ assetId: "alpha", missingItems }],
  };
  return { replay, registry };
}

const reason = (code, gapIds, path = "control:alpha") => ({ code, path, causeGapIds: gapIds });
const registryRow = (gapId, claimGroupId, cause = "C") => ({ gapId, claimGroupId, cause, reasonCode: "unresolved-control-identity" });

describe("Safety Score v9 curation worklist bands", () => {
  it("hides documentation-class items from the default streams and lists them only under the explicit band", () => {
    const docGap = "alpha:gap:economic-control:custody";
    const { replay, registry } = bandFixture(
      [reason("unresolved-control-identity", [docGap])],
      [registryRow(docGap, "DEPLOYMENT_CONTROLS:alpha")],
    );
    const documentationGaps = new Map([[docGap, { reason: "no-scoring-path" }]]);

    const defaultMarkdown = renderCurationWorklist(replay, registry, "capture.json", { documentationGaps });
    expect(defaultMarkdown).not.toContain("| CTRL-alpha |");
    expect(defaultMarkdown).toContain("Documentation-class items are not in the streams: **1** hidden");

    const explicitMarkdown = renderCurationWorklist(replay, registry, "capture.json", {
      includeDocumentation: true,
      documentationGaps,
    });
    expect(explicitMarkdown).toContain("## DOC — Documentation class, non-scoring (1)");
    expect(explicitMarkdown).toContain("| CTRL-alpha | CTRL |");
    expect(explicitMarkdown).toContain("no-scoring-path");
    expect(explicitMarkdown).not.toContain("Documentation-class items are not in the streams");
  });

  it("keeps a mixed item in the streams with only its required codes and causes", () => {
    const docGap = "alpha:gap:economic-control:custody";
    const requiredGap = "alpha:gap:economic-control:mint";
    const { replay, registry } = bandFixture(
      [
        reason("unresolved-control-identity", [docGap]),
        reason("missing-mint-authority", [requiredGap], "economic-control:mint"),
      ],
      [registryRow(docGap, "DEPLOYMENT_CONTROLS:alpha"), registryRow(requiredGap, "MINT_AUTHORITY:alpha")],
    );

    const markdown = renderCurationWorklist(replay, registry, "capture.json", {
      documentationGaps: new Map([[docGap, { reason: "immaterial-deployment" }]]),
    });
    expect(markdown).toContain("| ☐ | CTRL-alpha |");
    expect(markdown).toContain("missing-mint-authority");
    expect(markdown).not.toContain("unresolved-control-identity");
    expect(markdown).toContain("C: alpha:gap:economic-control:mint");
    expect(markdown).not.toContain(`C: ${docGap}`);
  });

  it("drops parked claim groups from every band while the rest of the asset stays visible", () => {
    const parkedGap = "alpha:gap:economic-control:custody";
    const { replay, registry } = bandFixture(
      [
        reason("unresolved-control-identity", [parkedGap]),
        reason("missing-reserve-composition", ["alpha:gap:reserve:composition"], "reserve"),
      ],
      [registryRow(parkedGap, "DEPLOYMENT_CONTROLS:alpha"), registryRow("alpha:gap:reserve:composition", "RESERVE_COMPOSITION:alpha")],
    );

    const markdown = renderCurationWorklist(replay, registry, "capture.json", {
      includeDocumentation: true,
      documentationGaps: new Map([[parkedGap, { reason: "no-scoring-path" }]]),
      parkedClaimGroups: new Set(["DEPLOYMENT_CONTROLS:alpha"]),
    });
    expect(markdown).not.toContain("CTRL-alpha");
    expect(markdown).toContain("| ☐ | RESV-alpha |");
    expect(markdown).toContain("Parked claim groups are hidden from every band: **1** groups (1 open reasons)");
    expect(markdown).not.toContain("Documentation-class, non-scoring (1)");
  });

  it("keeps gap-less and partially documented reasons in the default streams (fail closed)", () => {
    const docGap = "alpha:gap:economic-control:custody";
    const { replay, registry } = bandFixture(
      [
        { code: "unresolved-control-identity", path: "control:alpha" },
        reason("missing-mint-authority", [docGap, "alpha:gap:economic-control:authority"], "economic-control:mint"),
      ],
      [registryRow(docGap, "DEPLOYMENT_CONTROLS:alpha"), registryRow("alpha:gap:economic-control:authority", "MINT_AUTHORITY:alpha")],
    );

    const markdown = renderCurationWorklist(replay, registry, "capture.json", {
      documentationGaps: new Map([[docGap, { reason: "no-scoring-path" }]]),
      parkedClaimGroups: new Set(["DEPLOYMENT_CONTROLS:alpha"]),
    });
    expect(markdown).toContain("| ☐ | CTRL-alpha |");
    expect(markdown).toContain("unresolved-control-identity");
    expect(markdown).toContain("missing-mint-authority");
  });
});

describe("Safety Score v9 curation worklist routing", () => {

  it("fails closed when a reason has no typed curation disposition", () => {
    expect(() => classifyV9CurationWorklistStream("unregistered-reason")).toThrow(
      /Missing agent work-type definition/,
    );
  });

  it("gives every known reason exactly one routed or non-curation disposition", () => {
    const seenReasons = new Set<string>();
    for (const descriptor of Object.values(V9_MISSING_DATA_WORK_TYPES)) {
      expect(Object.keys(descriptor.reasonDispositions).sort()).toEqual([...descriptor.reasonCodes].sort());
      for (const reasonCode of descriptor.reasonCodes) {
        expect(seenReasons.has(reasonCode)).toBe(false);
        seenReasons.add(reasonCode);
        const disposition = descriptor.reasonDispositions[reasonCode];
        expect(disposition).toBeDefined();
        expect(classifyV9CurationWorklistStream(reasonCode)).toBe(
          disposition?.disposition === "routed" ? disposition.stream : null,
        );
      }
    }
    // Compare to the producer schema, not just the router's own descriptors:
    // an omitted reason must fail even when the remaining table is consistent.
    expect([...seenReasons].sort()).toEqual(
      expect.arrayContaining(V9_REASON_CODES.filter((code) => code !== "missing-pillar-evidence")),
    );
  });

  it("renders the registry agent protocol verbatim and the current redemption methodology version", () => {
    const replay = {
      pipeline: {
        candidate: { cards: [] },
        evaluatedSet: { assets: [] },
      },
    };
    const registry = {
      agentProtocol,
      summary: { stablecoinCount: 0, warnings: [] },
      stablecoins: [],
    };
    const markdown = renderCurationWorklist(replay, registry, "capture.json");
    const protocol = markdown.split("## Protocol for agents\n\n")[1].split("\n\nItem ID format:")[0];
    expect(protocol).toBe([
      `1. ${agentProtocol.claim}`,
      `2. ${agentProtocol.collisionAvoidance}`,
      `3. ${agentProtocol.evidenceStandard}`,
      `4. ${agentProtocol.verification}`,
      `5. ${agentProtocol.editPolicy}`,
    ].join("\n"));
    expect(markdown).toContain(`redemption methodology v${REDEMPTION_BACKSTOP_METHODOLOGY_VERSION} derives`);
    expect(markdown).not.toContain("redemption methodology v4.18");
  });

  it("renders mixed known, null, missing and zero supplies without false coverage or smallest-asset ordering", () => {
    const supplies = [
      { id: "zero", supply: 0 },
      { id: "unknown-z", supply: null },
      { id: "known", supply: 2_000_000 },
      { id: "unknown-a", supply: undefined },
    ];
    const cards = supplies.map(({ id }) => ({ id, ratingStatus: "rated", grade: "B", score: 75 }));
    const replay = {
      pipeline: {
        candidate: { cards },
        evaluatedSet: {
          assets: supplies.map(({ id, supply }) => ({
            assetId: id,
            ...(supply === undefined ? {} : { stressState: { exitPortfolio: { circulatingUsd: supply } } }),
            scoreInput: {
              pillars: {
                backing: { reasons: [{ code: "missing-reserve-composition", path: "reserve" }] },
                exit: { reasons: [] },
                control: { reasons: [] },
              },
              peg: { reasons: [] },
              dependencyReasons: [],
            },
            backing: { archetype: "fiat-cash", contributions: [] },
          })),
        },
      },
    };
    const registry = {
      agentProtocol,
      summary: { stablecoinCount: 4, warnings: [] },
      stablecoins: supplies.map(({ id }) => ({ assetId: id, missingItems: [] })),
    };
    const markdown = renderCurationWorklist(replay, registry, "capture.json");
    expect(markdown).toContain("2 known (including observed zero), 2 unavailable");
    expect(markdown).toContain("Known-supply subtotal: $2.0M; not a full-cohort total");
    expect(markdown).toContain("Rated share of known supply only: 100.00%; not full-cohort supply coverage");
    expect(markdown).toContain("| RESV-zero | P3 | $0 |");
    expect(markdown).toContain("| RESV-unknown-a | unknown supply | unavailable (missing-captured-supply) |");
    expect(markdown.indexOf("RESV-unknown-a")).toBeLessThan(markdown.indexOf("RESV-unknown-z"));
    expect(markdown.indexOf("RESV-unknown-z")).toBeLessThan(markdown.indexOf("RESV-known"));
    expect(markdown.indexOf("RESV-known")).toBeLessThan(markdown.indexOf("RESV-zero"));
    replay.pipeline.evaluatedSet.assets[2].stressState!.exitPortfolio.circulatingUsd = 0;
    expect(renderCurationWorklist(replay, registry, "capture.json")).toContain(
      "Rated share of known supply only: unavailable (zero known-supply denominator)",
    );
  });
});
