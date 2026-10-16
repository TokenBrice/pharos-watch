import { describe, expect, it } from "vitest";
import {
  EDITORIAL_POLICY,
  editorialRegister,
  scanEditorialText,
  severityFor,
} from "../editorial-style";

const ruleIds = (text: string, register = "daily") =>
  scanEditorialText(text, { register }).map((finding) => finding.ruleId);

const hardIds = (text: string, register = "daily") =>
  scanEditorialText(text, { register })
    .filter((finding) => finding.severity === "hard")
    .map((finding) => finding.ruleId);

describe("editorial style policy", () => {
  it("rejects an unknown register instead of silently scanning nothing", () => {
    expect(() => editorialRegister("not-a-register")).toThrow(/Unknown register/);
    const registerIds = EDITORIAL_POLICY.registers.map((register) => register.id);
    expect(registerIds).toContain("daily");
    expect(registerIds).toContain("cemetery");
  });
});

describe("hard rules catch real machine tells", () => {
  it("blocks investment recommendations anywhere", () => {
    expect(hardIds("We recommend holding the asset.", "coin-summary")).toContain("no-investment-recommendation");
  });
});

describe("structured canonical examples", () => {
  const activeRegisterFor = (rule: (typeof EDITORIAL_POLICY.rules)[number]): string => {
    const hard = EDITORIAL_POLICY.registers.find((register) => severityFor(rule, register.id) === "hard");
    const advisory = EDITORIAL_POLICY.registers.find((register) => severityFor(rule, register.id) === "advisory");
    const active = hard ?? advisory;
    if (!active) throw new Error(`rule ${rule.id} has no active register`);
    return active.id;
  };

  it("makes every violating example executable through the real scanner", () => {
    for (const rule of EDITORIAL_POLICY.rules) {
      const register = activeRegisterFor(rule);
      for (const example of rule.examples.violating) {
        const ids = ruleIds(example, register);
        expect(ids, `${rule.id} should match in ${register}: ${example}`).toContain(rule.id);
      }
    }
  });

  it("keeps every clean example free of its paired rule", () => {
    for (const rule of EDITORIAL_POLICY.rules) {
      const register = activeRegisterFor(rule);
      for (const example of rule.examples.clean) {
        const ids = ruleIds(example, register);
        expect(ids, `${rule.id} should not match in ${register}: ${example}`).not.toContain(rule.id);
      }
    }
  });
});

describe("severity is scoped per register", () => {
  it("hardens unqualified safety claims only on product surfaces", () => {
    expect(hardIds("A safe place to park dollars.", "page-description")).toContain("no-unqualified-safety");
    expect(hardIds("A safe place to park dollars.", "coin-summary")).not.toContain("no-unqualified-safety");
  });
});
