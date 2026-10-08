import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { FailureScenario } from "../../types/failure-scenarios";
import {
  FailureScenarioSchema,
  FailureScenariosByIdSchema,
  computeFailureScenarioContentHash,
  selectFailureScenario,
} from "../failure-scenarios";
import { stableJsonStringifyV1 } from "../stable-json";
import { checkFailureScenarios } from "../../../scripts/ci/check-failure-scenarios";

const now = new Date("2026-10-07T12:00:00.000Z");

// Authored in-memory fixture, never imported from or written to the editorial file.
function fixture(): FailureScenario {
  return {
    coinId: "crvusd-curve",
    title: "How does a fixture break?",
    thesis: "A hypothetical fixture only.",
    premise: "Assume the fictional authority is captured; no compromise is observed.",
    stages: [
      {
        id: "capture", kind: "authority-capture", title: "Capture authority", actor: "Hypothetical attacker",
        action: "capture()", actionIsCode: true, elapsed: "T+0", cost: "One transaction",
        explanation: "A test precondition.", evidence: "inferred", sourceIds: ["source"],
        targets: [{ label: "Fixture contract", address: "0x0000000000000000000000000000000000000001", chainId: 1 }],
      },
      {
        id: "outcome", kind: "holder-outcome", title: "Holder consequence", actor: "Holders",
        action: "Absorb a hypothetical loss", elapsed: "T+1d", cost: "One day",
        explanation: "A hypothetical test outcome.", evidence: "inferred", sourceIds: [],
      },
    ],
    keyFigures: [{ value: "3 of 5", label: "Hypothetical threshold", evidence: "inferred", sourceIds: ["source"] }],
    window: { label: "Response window", fromStageId: "capture", toStageId: "outcome", duration: "One day", note: "Hypothetical." },
    defenders: [{ name: "Fixture defender", verdict: "partial", why: "A qualified test claim.", evidence: "documented", sourceIds: ["source"] }],
    falsifiers: [{ id: "route-removed", condition: "The route is removed", status: "not-met", checkedAtBlock: 100 }],
    exposure: [{ label: "Holders", detail: "A qualitative test consequence.", evidence: "inferred" }],
    sources: [{ id: "source", label: "Fixture source", url: "https://example.com/evidence", observedAt: "2026-10-07", block: 100 }],
    evidencePin: { chainId: 1, block: 100, observedAt: "2026-10-07" },
    review: { status: "draft" },
  };
}

function branchedFixture(): FailureScenario {
  const scenario = fixture();
  scenario.branchPoint = {
    afterStageId: "capture",
    branches: [
      {
        id: "operator", label: "Operator route", keys: "1 key", premise: "A hypothetical operator compromise.",
        stages: [{ ...scenario.stages[0]!, id: "operator-capture" }],
      },
      {
        id: "safe", label: "Safe route", keys: "3 of 5", premise: "A hypothetical threshold compromise.",
        stages: [
          { ...scenario.stages[0]!, id: "safe-capture" },
          { ...scenario.stages[0]!, id: "safe-action" },
        ],
      },
    ],
  };
  return scenario;
}

function approvedFixture(): FailureScenario {
  const scenario = fixture();
  scenario.review = {
    status: "approved", reviewedBy: "Fixture reviewer", reviewedAt: now.toISOString(),
    contentSha256: computeFailureScenarioContentHash(scenario),
  };
  return scenario;
}

function select(scenario: FailureScenario, allowDrafts = false, clock = now) {
  return selectFailureScenario({ [scenario.coinId]: scenario }, scenario.coinId, { allowDrafts, now: clock });
}

describe("failure scenario publication", () => {
  it("hides drafts in production and marks explicitly allowed previews", () => {
    const scenario = fixture();
    expect(select(scenario)).toBeNull();
    expect(select(scenario, true)).toEqual({ scenario, isDraft: true });
  });

  it("publishes an approved, hash-bound record at review and years later", () => {
    const scenario = approvedFixture();
    expect(select(scenario)).toEqual({ scenario, isDraft: false });
    expect(select(scenario, false, new Date("2036-10-07T12:00:00.000Z"))).toEqual({ scenario, isDraft: false });
  });

  it.each([
    { label: "thesis", edit: (scenario: FailureScenario) => { scenario.thesis = "An edited thesis."; } },
    { label: "stage", edit: (scenario: FailureScenario) => { scenario.stages[0]!.explanation = "An edited claim."; } },
    { label: "source", edit: (scenario: FailureScenario) => { scenario.sources[0]!.block = 101; } },
    { label: "evidence pin", edit: (scenario: FailureScenario) => { scenario.evidencePin.block = 101; } },
    { label: "falsifier", edit: (scenario: FailureScenario) => { scenario.falsifiers[0]!.status = "unverified"; } },
    { label: "ordering", edit: (scenario: FailureScenario) => { scenario.stages.reverse(); } },
  ])("hides a $label edit after approval, even in draft preview mode", ({ edit }) => {
    const scenario = approvedFixture();
    edit(scenario);
    expect(select(scenario)).toBeNull();
    expect(select(scenario, true)).toBeNull();
  });

  it("suspends met falsifiers even when the content hash is valid", () => {
    const scenario = approvedFixture();
    scenario.falsifiers[0]!.status = "met";
    if (scenario.review.status === "approved") scenario.review.contentSha256 = computeFailureScenarioContentHash(scenario);
    expect(select(scenario)).toBeNull();
    scenario.review = { status: "draft" };
    expect(select(scenario, true)).toBeNull();
  });

  it("withholds future reviews but publishes at the reviewed timestamp", () => {
    const scenario = approvedFixture();
    expect(select(scenario, false, new Date(now.getTime() - 1))).toBeNull();
    expect(select(scenario, true, new Date(now.getTime() - 1))).toBeNull();
    expect(select(scenario, false, now)).toEqual({ scenario, isDraft: false });
  });

  it("fails closed on malformed and absent selected records", () => {
    const scenario = approvedFixture();
    scenario.evidencePin.observedAt = "2026-02-30";
    expect(select(scenario)).toBeNull();
    expect(selectFailureScenario({}, "crvusd-curve", { allowDrafts: true, now })).toBeNull();
    expect(selectFailureScenario({ other: approvedFixture() }, "other", { allowDrafts: true, now })).toBeNull();
  });
});

describe("failure scenario schema and identity", () => {
  it.each(["stages", "defenders", "keyFigures"] as const)("rejects dangling %s sourceIds", (field) => {
    const scenario = fixture();
    scenario[field][0]!.sourceIds = ["missing"];
    expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects unknown catalog ids and mismatched record keys", () => {
    const scenario = fixture();
    expect(FailureScenariosByIdSchema.safeParse({ other: scenario }).success).toBe(false);
    scenario.coinId = "unknown-fixture-coin";
    expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("requires canonical falsifier ids and rejects duplicate ids within a record", () => {
    const duplicate = fixture();
    duplicate.falsifiers.push({ ...duplicate.falsifiers[0]!, condition: "A different condition" });
    const result = FailureScenarioSchema.safeParse(duplicate);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(expect.objectContaining({
        path: ["falsifiers", 1, "id"], message: "Duplicate falsifier id",
      }));
    }
    const missingId = fixture();
    Reflect.deleteProperty(missingId.falsifiers[0]!, "id");
    const blankId = fixture();
    blankId.falsifiers[0]!.id = " ";
    for (const scenario of [missingId, blankId]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
    const distinct = fixture();
    distinct.falsifiers.push({ ...distinct.falsifiers[0]!, id: "another-route-removed" });
    expect(FailureScenarioSchema.safeParse(distinct).success).toBe(true);
  });

  it("accepts a branched chain with references into branch stages", () => {
    const scenario = branchedFixture();
    scenario.window!.fromStageId = "safe-capture";
    scenario.window!.toStageId = "outcome";
    expect(FailureScenarioSchema.safeParse(scenario).success).toBe(true);
    expect(select(scenario, true)).toEqual({ scenario, isDraft: true });
  });

  it.each(["missing", "operator-capture", "outcome"])("rejects invalid branch splice stage %s", (afterStageId) => {
    const scenario = branchedFixture();
    scenario.branchPoint!.afterStageId = afterStageId;
    expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects duplicate stage ids across trunk and branches or between branches", () => {
    const trunkDuplicate = branchedFixture();
    trunkDuplicate.branchPoint!.branches[0]!.stages[0]!.id = "capture";
    const branchDuplicate = branchedFixture();
    branchDuplicate.branchPoint!.branches[1]!.stages[0]!.id = "operator-capture";
    for (const scenario of [trunkDuplicate, branchDuplicate]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("requires unique branch ids, at least two branches, and nonempty branch stages", () => {
    const duplicate = branchedFixture();
    duplicate.branchPoint!.branches[1]!.id = duplicate.branchPoint!.branches[0]!.id;
    const single = branchedFixture();
    single.branchPoint!.branches.pop();
    const empty = branchedFixture();
    empty.branchPoint!.branches[0]!.stages = [];
    for (const scenario of [duplicate, single, empty]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("validates every branch source and rejects unknown nested branch or figure fields", () => {
    const dangling = branchedFixture();
    dangling.branchPoint!.branches[0]!.stages[0]!.sourceIds = ["missing"];
    const extraBranch = branchedFixture();
    Object.assign(extraBranch.branchPoint!.branches[0]!, { unknown: true });
    const extraFigure = fixture();
    Object.assign(extraFigure.keyFigures[0]!, { unknown: true });
    for (const scenario of [dangling, extraBranch, extraFigure]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
    const missingFigures = { ...fixture() };
    Reflect.deleteProperty(missingFigures, "keyFigures");
    expect(FailureScenarioSchema.safeParse(missingFigures).success).toBe(false);
  });

  it("orders windows by trunk prefix, authored branches and their stages, then trunk suffix", () => {
    const scenario = branchedFixture();
    for (const [from, to] of [
      ["capture", "operator-capture"],
      ["operator-capture", "safe-capture"],
      ["safe-capture", "safe-action"],
      ["safe-action", "outcome"],
    ]) {
      scenario.window!.fromStageId = from!;
      scenario.window!.toStageId = to!;
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(true);
      scenario.window!.fromStageId = to!;
      scenario.window!.toStageId = from!;
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
    scenario.window!.fromStageId = "operator-capture";
    scenario.window!.toStageId = "missing";
    expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
  });

  it("rejects duplicate stage/source ids and missing or reversed window references", () => {
    const duplicateStage = fixture();
    duplicateStage.stages[1]!.id = duplicateStage.stages[0]!.id;
    const duplicateSource = fixture();
    duplicateSource.sources.push({ ...duplicateSource.sources[0]! });
    const missingWindow = fixture();
    missingWindow.window!.toStageId = "missing";
    const reversedWindow = fixture();
    reversedWindow.window!.fromStageId = "outcome";
    reversedWindow.window!.toStageId = "capture";
    for (const scenario of [duplicateStage, duplicateSource, missingWindow, reversedWindow]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
  });

  it("rejects impossible dates, malformed addresses, non-HTTP sources, and unknown fields", () => {
    const invalidDate = fixture();
    invalidDate.sources[0]!.observedAt = "2026-02-30";
    const invalidAddress = fixture();
    invalidAddress.stages[0]!.targets![0]!.address = "0xgg";
    const invalidUrl = { ...fixture(), sources: [{ id: "source", label: "Bad URL", url: "ftp://example.com" }] };
    for (const scenario of [invalidDate, invalidAddress, invalidUrl, { ...fixture(), unknown: true }]) {
      expect(FailureScenarioSchema.safeParse(scenario).success).toBe(false);
    }
    const invalidNested = fixture();
    Object.assign(invalidNested.stages[0]!, { unknown: true });
    expect(FailureScenarioSchema.safeParse(invalidNested).success).toBe(false);
  });

  it("hashes sorted content keys and UTF-8, ignoring review metadata but not array order", () => {
    const scenario = fixture();
    scenario.thesis = "Qualified € / 😀 claim.";
    const { review: _review, ...content } = scenario;
    expect(computeFailureScenarioContentHash(scenario)).toBe(
      createHash("sha256").update(stableJsonStringifyV1(content)).digest("hex"),
    );
    const reordered = Object.fromEntries(Object.entries(scenario).reverse()) as unknown as FailureScenario;
    reordered.review = { status: "draft", note: "A review note only." };
    expect(computeFailureScenarioContentHash(reordered)).toBe(computeFailureScenarioContentHash(scenario));
    const reversedStages = structuredClone(scenario);
    reversedStages.stages.reverse();
    expect(computeFailureScenarioContentHash(reversedStages)).not.toBe(computeFailureScenarioContentHash(scenario));
  });
});

describe("failure scenario CI gate", () => {
  it("allows valid drafts and current approvals without loading real editorial data", () => {
    expect(checkFailureScenarios({ "crvusd-curve": fixture() }, now)).toEqual([]);
    expect(checkFailureScenarios({ "crvusd-curve": approvedFixture() }, now)).toEqual([]);
  });

  it("reports malformed references and invalid approved publication conditions", () => {
    const edited = approvedFixture();
    edited.thesis = "Edited.";
    expect(checkFailureScenarios({ "crvusd-curve": edited }, now)).toContain("crvusd-curve: Approved content hash mismatch");
    const scenario = approvedFixture();
    expect(checkFailureScenarios({ "crvusd-curve": scenario }, new Date(now.getTime() - 1)))
      .toContain("crvusd-curve: Review is in the future");
    scenario.falsifiers[0]!.status = "met";
    expect(checkFailureScenarios({ "crvusd-curve": scenario }, now)).toContain("crvusd-curve: Scenario falsifier is met");
    const dangling = fixture();
    dangling.stages[0]!.sourceIds = ["missing"];
    expect(checkFailureScenarios({ "crvusd-curve": dangling }, now)[0]).toContain("Unknown source id: missing");
  });
});
