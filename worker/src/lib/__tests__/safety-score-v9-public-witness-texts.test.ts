import { describe, expect, it, vi } from "vitest";
import type * as WitnessTextModule from "@shared/lib/safety-score-v9/public-witness-texts";
import { SafetyScoreV9CurrentCardSchema } from "@shared/types/safety-score-v9-public";
import { iterateEvidenceResponsibilityFacts, type V9EvidenceFactContext } from "@shared/types/safety-score-v9-public-evidence-facts";
import { normalizeFixedInput } from "../report-cards-fixed-input";
import { createSafetyScoreV9FullRegistryInput } from "./fixtures/safety-score-v9-full-registry-input";
import { buildSafetyScoreV9PublicationFromNormalizedInput } from "../safety-score-v9/candidate";
import { buildAlertSafetyV9SourceEnvelopeFromParts } from "../alert-safety-source-cache";
import { internV9PublicWitnessTexts } from "@shared/lib/safety-score-v9/public-witness-texts";
import { resolveV9PublicWitnessTexts, validateV9PublicWitnessTexts } from "@shared/types/safety-score-v9-public-witness-texts";
import { resolveCauseGapId } from "@shared/types/safety-score-v9-public-cause-gaps";

const captured = vi.hoisted(() => ({ usdc: null as object | null, resolvedCards: 0 }));
vi.mock("@shared/lib/safety-score-v9/public-witness-texts", async (importOriginal) => {
  const actual = await importOriginal<typeof WitnessTextModule>();
  return {
    ...actual,
    internV9PublicWitnessTexts: <T extends object>(card: T) => {
      if ("id" in card && card.id === "usdc-circle") captured.usdc = structuredClone(card);
      const wire = actual.internV9PublicWitnessTexts(card);
      if ("id" in card) {
        expect(resolveV9PublicWitnessTexts(wire)).toEqual(card);
        captured.resolvedCards++;
      }
      return wire;
    },
  };
});

describe("card-local public witness texts", () => {
  it("losslessly shares repeated messages and paths without mutating evaluator views", () => {
    const message = "The exact independently scoped incident disposition remains unknown.";
    const path = "control:ethereum:0x123:incidentState:cause:7";
    const input = { reasons: [{ message, path }, { message, path }], attribution: { message, path }, untouched: { count: 0, label: "Short one-off label" } };
    const before = structuredClone(input);
    const wire = internV9PublicWitnessTexts(input);
    expect(wire.witnessTexts).toEqual([message, path].sort());
    expect(wire.reasons[0]?.message).toMatch(/^~/u);
    expect(wire.untouched).toBe(input.untouched);
    expect(input).toEqual(before);
    expect(resolveV9PublicWitnessTexts(wire)).toEqual(before);
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(before).length);
    expect(() => validateV9PublicWitnessTexts(wire)).not.toThrow();
  });

  it("losslessly interns shared component identities and scoped-risk keys", () => {
    const key = "bridge:ethereum:0x1111111111111111111111111111111111111111:control:mint";
    const input = {
      pillar: { evidenceLevel: "medium", components: [key], supportedComponentKeys: [key] },
      localCauseGaps: [key], foreignCauseGapRefs: [],
      component: { key, posture: "unknown", binding: false },
      authority: { model: "contract", authorityKey: key },
      deployment: { signalKey: `signal:${key}`, exposureKey: key, riskEventKey: `event:${key}`, failureDomainKeys: [key] },
    };
    const before = structuredClone(input);
    const wire = internV9PublicWitnessTexts(input);
    expect(wire.pillar.components[0]).toMatch(/^~/u);
    expect(wire.component.key).toBe(wire.pillar.components[0]);
    expect(wire.authority.authorityKey).toBe(wire.component.key);
    expect(wire.deployment.failureDomainKeys[0]).toBe(wire.component.key);
    expect(resolveV9PublicWitnessTexts(wire)).toEqual(before);
    expect(input).toEqual(before);
    expect(resolveCauseGapId({ foreignCauseGaps: [] }, { ...wire, id: "fixture" }, 0)).toBe(`fixture:gap:${key}`);
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(before).length);
  });

  it("escapes reserved literal text and leaves a non-beneficial ordinary card inline", () => {
    const input = { message: "~literal", path: "short", field: null, facts: [["arbitrary tuple text"]] };
    const wire = internV9PublicWitnessTexts(input);
    expect(wire.message).toMatch(/^~/u);
    expect(wire.path).toBe("short");
    expect(resolveV9PublicWitnessTexts(wire)).toEqual(input);
    expect(resolveV9PublicWitnessTexts({ path: "inline", witnessTexts: undefined })).toEqual({ path: "inline", witnessTexts: undefined });
  });

  it("shares long distinct path prefixes without collapsing witness identity", () => {
    const prefix = "control:bridge:ethereum:0x1111111111111111111111111111111111111111:";
    const input = { reasons: ["authority", "incidentState", "custody"].map((factor) => ({ message: "Unknown", path: prefix + factor })) };
    const wire = internV9PublicWitnessTexts(input);
    expect(wire.witnessTexts?.some(Array.isArray)).toBe(true);
    expect(resolveV9PublicWitnessTexts(wire)).toEqual(input);
    expect(() => validateV9PublicWitnessTexts(wire)).not.toThrow();
  });

  it.each([
    [-1, 1, "suffix"],
    [1, 1, "suffix"],
    [0, 100, "suffix"],
  ])("rejects invalid prefix references %j", (...prefix) => {
    const wire = { witnessTexts: ["base", prefix as [number, number, string]], message: "~0", path: "~1" };
    expect(() => validateV9PublicWitnessTexts(wire)).toThrow();
  });

  it.each([
    { witnessTexts: ["text"], message: "~1" },
    { witnessTexts: ["text"], message: "~00" },
    { witnessTexts: ["text"], message: "~invalid!" },
    { witnessTexts: ["text"], message: "inline" },
    { witnessTexts: ["z", "a"], message: "~0", path: "~1" },
    { witnessTexts: ["a", "a"], message: "~0", path: "~1" },
    { witnessTexts: [], message: "inline" },
    { message: "~0" },
  ])("rejects malformed, missing or unused dictionary entries: %j", (wire) => {
    expect(() => validateV9PublicWitnessTexts(wire)).toThrow();
  });

  it("decodes every compact categorical column and singleton root without changing its meaning", () => {
    const compact: V9EvidenceFactContext = { facts: [[0, "source:unknown", null, 6, 0, 3, 2]] };
    expect([...iterateEvidenceResponsibilityFacts(compact)]).toEqual([
      ["bounded-mechanism-review", "source:unknown", null, "unresearched", false, "U", [2]],
    ]);
  });

  it("resolves every real full-registry card losslessly and preserves admitted USDC consumers", () => {
    const fixedInput = normalizeFixedInput(createSafetyScoreV9FullRegistryInput());
    const { candidate } = buildSafetyScoreV9PublicationFromNormalizedInput({ fixedInput, publishedAtSec: fixedInput.clockSec });
    const card = candidate.cards.find((item) => item.id === "usdc-circle");
    expect(card).toBeDefined();
    expect(captured.resolvedCards).toBe(candidate.cards.length);
    expect(captured.usdc).not.toBeNull();
    if (captured.usdc === null || !("foreignCauseGaps" in captured.usdc)) throw new Error("USDC draft was not captured");
    const { foreignCauseGaps: _foreign, ...before } = captured.usdc;
    expect(card!.witnessTexts?.length).toBeGreaterThan(0);
    const admittedBefore = SafetyScoreV9CurrentCardSchema.parse({ ...before, foreignCauseGapRefs: card!.foreignCauseGapRefs });
    expect(resolveV9PublicWitnessTexts(card!)).toEqual(admittedBefore);
    expect(SafetyScoreV9CurrentCardSchema.safeParse(card).success).toBe(true);
    const facts = card!.scoreTrace.evidenceResponsibility.facts;
    expect(facts.length).toBeGreaterThan(0);
    expect(facts.every((row) => typeof row[0] === "number" && typeof row[3] === "number" && typeof row[4] === "number" && typeof row[5] === "number")).toBe(true);
    const badFlag = structuredClone(card!);
    (badFlag.scoreTrace.evidenceResponsibility.facts[0] as unknown[])[4] = 2;
    expect(SafetyScoreV9CurrentCardSchema.safeParse(badFlag).success).toBe(false);
    const corrupted = structuredClone(card!);
    corrupted.pillars.control.reasons[0]!.message = "~zzzzzz";
    expect(SafetyScoreV9CurrentCardSchema.safeParse(corrupted).success).toBe(false);
    const unresolved = candidate.cards.find((item) => item.scoreTrace.boundedUncertaintyAttribution.items.length > 1);
    expect(unresolved).toBeDefined();
    const reordered = structuredClone(unresolved!);
    reordered.scoreTrace.boundedUncertaintyAttribution.items.reverse();
    expect(SafetyScoreV9CurrentCardSchema.safeParse(reordered).success).toBe(false);
    const reorderedComponents = structuredClone(card!);
    reorderedComponents.pillars.control.components.reverse();
    expect(SafetyScoreV9CurrentCardSchema.safeParse(reorderedComponents).success).toBe(false);
    const reorderedExposures = structuredClone(card!);
    reorderedExposures.scoreTrace.deploymentRisk.unresolvedExposures.reverse();
    expect(SafetyScoreV9CurrentCardSchema.safeParse(reorderedExposures).success).toBe(false);
    const parts = { cards: [card!], safetyScoreIdentity: {
      model: "v9" as const, schemaVersion: 1 as const, methodologyVersion: candidate.policyVersion,
      policyId: candidate.policy.id, policyDigest: candidate.policy.semanticDigest,
      evaluationBuildDigest: candidate.evaluationBuildDigest, baseInputGenerationId: candidate.baseInputGenerationId,
      publicationGenerationId: candidate.publicationGenerationId,
    }, publishedAt: candidate.publishedAtSec };
    expect(buildAlertSafetyV9SourceEnvelopeFromParts(parts)).toEqual(buildAlertSafetyV9SourceEnvelopeFromParts({
      ...parts, cards: [resolveV9PublicWitnessTexts(card!)],
    }));
  // One full-registry publication: 23s in the plain lane, 41-81s under V8 coverage.
  }, 180_000);
});
