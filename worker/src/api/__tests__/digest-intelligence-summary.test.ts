import { describe, it, expect } from "vitest";
import { selectDigestIntelligence } from "../digest-intelligence-summary";

const validTrigger = {
  id: "trigger:depeg:pmusd",
  label: "PMUSD depeg widening",
  metric: "depeg-bps",
  comparator: "abs-gte",
  thresholdLabel: "5500 bps off peg",
  rationale: "A wider deviation raises severity.",
  detail: "If PMUSD reaches 5500 bps off peg, severity rises.",
};

const validRiskTapeItem = {
  id: "risk-tape:depegs",
  label: "Depegs",
  value: "PMUSD 5284bps",
  tone: "critical",
};

const validOutcome = {
  id: "outcome:1",
  triggerId: "trigger:1",
  label: "PMUSD trigger",
  status: "hit",
  detail: "Threshold reached.",
};

const validChangeSummary = {
  newSignals: [],
  worsenedSignals: [],
  improvedSignals: [],
  resolvedSignals: [],
  repeatedSignals: [],
};

describe("selectDigestIntelligence", () => {
  it("returns all-null for non-record input", () => {
    expect(selectDigestIntelligence(null)).toEqual({
      changeSummary: null,
      nextTriggers: null,
      forwardLookOutcomes: null,
      riskTape: null,
      standingConditions: null,
    });
    expect(selectDigestIntelligence("garbage")).toEqual({
      changeSummary: null,
      nextTriggers: null,
      forwardLookOutcomes: null,
      riskTape: null,
      standingConditions: null,
    });
  });

  it("keeps well-formed elements", () => {
    const result = selectDigestIntelligence({
      changeSummary: validChangeSummary,
      nextTriggers: [validTrigger],
      forwardLookOutcomes: [validOutcome],
      riskTape: [validRiskTapeItem],
    });
    expect(result.changeSummary).toEqual(validChangeSummary);
    expect(result.nextTriggers).toEqual([validTrigger]);
    expect(result.forwardLookOutcomes).toEqual([validOutcome]);
    expect(result.riskTape).toEqual([validRiskTapeItem]);
  });

  it("drops malformed array elements while keeping valid ones", () => {
    const result = selectDigestIntelligence({
      nextTriggers: [validTrigger, { id: "broken" }, null, 42],
      forwardLookOutcomes: [{ id: "broken-outcome" }, validOutcome],
      riskTape: [validRiskTapeItem, { id: "x", label: "y", value: "z", tone: "not-a-tone" }],
    });
    expect(result.nextTriggers).toEqual([validTrigger]);
    expect(result.forwardLookOutcomes).toEqual([validOutcome]);
    expect(result.riskTape).toEqual([validRiskTapeItem]);
  });

  it("nulls a structurally-invalid changeSummary", () => {
    const result = selectDigestIntelligence({
      changeSummary: { newSignals: "not-an-array" },
    });
    expect(result.changeSummary).toBeNull();
  });

  it("returns null (not empty array) when a field is absent or non-array", () => {
    const result = selectDigestIntelligence({ nextTriggers: "nope" });
    expect(result.nextTriggers).toBeNull();
    expect(result.forwardLookOutcomes).toBeNull();
    expect(result.riskTape).toBeNull();
  });
});
