import { describe, expect, it } from "vitest";
import { makePublishedProcessDiagnostic } from "@shared/lib/__tests__/safety-score-v9-fixtures.test-support";
import type { V1005ProcessDiagnostic } from "@shared/types/safety-score-v9-facts";
import type { MintAuthorityProcessDiagnosticViewModel } from "../stablecoin-detail-mint-authority-view-model";
import {
  groupMintIssuanceDiagnostics,
  humanizeDiagnosticField,
  processReasonLabel,
} from "../mint-issuance-diagnostics";

const GOVERNOR_REF = `ethereum:0x${"a".repeat(40)}`;
const MINTER_REF = `ethereum:0x${"b".repeat(40)}`;

function diagnostic(
  row: Pick<V1005ProcessDiagnostic, "code" | "gate" | "field"> & Partial<V1005ProcessDiagnostic>,
  statusLabel: MintAuthorityProcessDiagnosticViewModel["statusLabel"],
  overrides: Parameters<typeof makePublishedProcessDiagnostic>[1] = {},
): MintAuthorityProcessDiagnosticViewModel {
  const published = makePublishedProcessDiagnostic({
    controlRef: GOVERNOR_REF, pathId: null, classId: null, memberRef: null, evidenceRefIds: [], ...row,
  }, overrides);
  return {
    ...published,
    key: JSON.stringify([published.gate, published.code, published.classId, published.field]),
    statusLabel,
  };
}

/** GHO-shaped input: one reason split across per-route field paths. */
const PER_ROUTE_CENSUS = [1, 2, 3, 4, 5].map((route) => diagnostic({
  code: "voting-census-unreconciled", gate: "D32", field: `routes.aave-l1-unopposed-${route}.controllerPowers`,
}, "Missing evidence"));

describe("groupMintIssuanceDiagnostics", () => {
  it("collapses groups that share a status and reason into one counted row", () => {
    const view = groupMintIssuanceDiagnostics(PER_ROUTE_CENSUS);

    expect(view.groups).toHaveLength(1);
    expect(view.groups[0]).toMatchObject({ count: 5, controlCount: 1, processLevel: false });
    // The per-route paths differ only by evaluator id, so they merge into one field row.
    expect(view.groups[0]!.fields).toEqual([{ label: expect.any(String), count: 5 }]);
  });

  it("conserves the published finding total and orders failures before missing proof", () => {
    const failed = diagnostic({ code: "governor-not-governance", gate: "shared", field: "authorityGraph.governorNodeId",
      controlRef: null }, "Failed gate");
    const reach = diagnostic({ code: "economic-reach-unclosed", gate: "shared", field: "executionScope" },
      "Missing evidence", { count: 10 });
    const input = [...PER_ROUTE_CENSUS, reach, failed];
    const view = groupMintIssuanceDiagnostics(input);

    expect(view.total).toBe(input.reduce((sum, row) => sum + row.count, 0));
    expect(view.groups.map((group) => group.status)).toEqual(["Failed gate", "Missing evidence", "Missing evidence"]);
    expect(view.groups[0]!.processLevel).toBe(true);
    expect(view.statusCounts).toEqual([
      { status: "Failed gate", count: 1 },
      { status: "Missing evidence", count: 15 },
    ]);
  });

  it("keeps one reason split by status apart", () => {
    const missing = diagnostic({ code: "runtime-unmatched", gate: "shared", field: "runtimeHash" }, "Missing evidence");
    const note = { ...missing, key: "note", statusLabel: "Analytical note" as const };
    expect(groupMintIssuanceDiagnostics([missing, note]).groups).toHaveLength(2);
  });

  it("counts duplicate published groups once", () => {
    const row = PER_ROUTE_CENSUS[0]!;
    expect(groupMintIssuanceDiagnostics([row, row]).total).toBe(row.count);
  });

  it("names the rendered controls a finding touches and counts the rest", () => {
    const shared = diagnostic({ code: "authority-state-mismatch", gate: "shared", field: "authorityBinding" },
      "Missing evidence", { count: 3, controlRefs: [GOVERNOR_REF, MINTER_REF, `ethereum:0x${"c".repeat(40)}`] });
    const view = groupMintIssuanceDiagnostics([shared], [
      { label: "Governor", processDiagnostics: [shared] },
      { label: "Unrelated", processDiagnostics: [] },
    ]);

    expect(view.groups[0]).toMatchObject({ controlCount: 3, controlLabels: ["Governor"] });
  });

  it("keeps evidence and class facts as counts, never as ids", () => {
    const certificate = diagnostic({ code: "process-certificate-unavailable", gate: "H0", field: "issuanceProcess.coverage",
      classId: "keeper-class", evidenceRefIds: ["e1", "e10", "e100", "e2"] }, "Missing evidence");
    const [group] = groupMintIssuanceDiagnostics([certificate]).groups;

    expect(group).toMatchObject({ classCount: 1, evidenceRefCount: 4 });
    expect(JSON.stringify(group)).not.toMatch(/\be\d+\b|keeper-class|\bH0\b/);
  });
});

describe("diagnostic reader labels", () => {
  it.each([
    "routes.aave-l1-unopposed-3.controllerPowers",
    "authorityGraph.nodes.gho-control-0cb7c2a2.proofRef",
    "censuses.gho-token-local-facilitators.members",
    "authorityGraph.edges.g121",
    "routes.public-minority-delegated-0x51bf5e119031578474f0bdcf4309054c3fed1733.minorityProtection",
    "controllers.convex-pooled-votes.otherHoldersPowerRaw",
  ])("drops evaluator ids from %s", (field) => {
    const label = humanizeDiagnosticField(field);
    expect(label).not.toBeNull();
    expect(label).not.toMatch(/[.\-]|0x|\d/);
  });

  it("merges sibling paths that differ only by id", () => {
    expect(humanizeDiagnosticField("routes.aave-l1-unopposed-1.residualUpperRaw"))
      .toBe(humanizeDiagnosticField("routes.aave-l1-unopposed-5.residualUpperRaw"));
  });

  it("keeps plain keys that follow a collection name", () => {
    expect(humanizeDiagnosticField("routes.controllerPowers.threshold"))
      .not.toBe(humanizeDiagnosticField("routes.threshold"));
  });

  it("reads reason codes newer than the label map as words, not slugs", () => {
    const label = processReasonLabel("execution-inventory-incomplete");
    expect(label).not.toContain("-");
    expect(processReasonLabel("voting-control-unproved")).not.toContain("-");
  });
});
