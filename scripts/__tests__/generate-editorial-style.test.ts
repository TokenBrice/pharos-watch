import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  canonicalize,
  extractPolicyBlock,
  policyHash,
  validatePolicy,
} from "../maintenance/generate-editorial-style.ts";

type MutablePolicy = Record<string, unknown> & {
  rules: Array<Record<string, unknown>>;
};

function readPolicy(): ReturnType<typeof validatePolicy> {
  const markdown = readFileSync(resolve(process.cwd(), "docs/editorial-style.md"), "utf8");
  return validatePolicy(extractPolicyBlock(markdown));
}

function clonePolicy(policy: ReturnType<typeof validatePolicy>): MutablePolicy {
  return JSON.parse(JSON.stringify(policy)) as MutablePolicy;
}

describe("editorial policy generator", () => {
  it("extracts and validates the single authored policy fence", () => {
    const policy = readPolicy();
    expect(policy.version).toBe("1.0");
    expect(policy.registers.length).toBeGreaterThan(0);
    expect(policy.rules.length).toBeGreaterThan(0);
    expect(policyHash(policy)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("hashes policy meaning independently of object key order", () => {
    const policy = readPolicy();
    const reorder = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reorder);
      if (!value || typeof value !== "object") return value;
      return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reorder(child)]));
    };
    const reordered = reorder(policy) as ReturnType<typeof validatePolicy>;
    expect(canonicalize(policy)).toBe(canonicalize(reordered));
    expect(policyHash(policy)).toBe(policyHash(reordered));

    const changed = clonePolicy(policy);
    const firstPattern = (changed.rules[0]!.patterns as Array<Record<string, unknown>>)[0]!;
    firstPattern.source = `${String(firstPattern.source)}(?:)`;
    expect(policyHash(policy)).not.toBe(policyHash(changed as ReturnType<typeof validatePolicy>));
  });

  it.each([
    ["duplicate rule ids", (candidate: MutablePolicy) => {
      candidate.rules[1]!.id = candidate.rules[0]!.id;
    }, /Duplicate rule id/],
    ["invalid regular expressions", (candidate: MutablePolicy) => {
      (candidate.rules[0]!.patterns as Array<Record<string, unknown>>)[0]!.source = "[";
    }, /uncompilable pattern/],
    ["non-global regular expressions", (candidate: MutablePolicy) => {
      (candidate.rules[0]!.patterns as Array<Record<string, unknown>>)[0]!.flags = "i";
    }, /global/],
    ["unknown register references", (candidate: MutablePolicy) => {
      (candidate.rules[0]!.severity as Record<string, unknown>).byRegister = { "not-a-register": "hard" };
    }, /unknown register/],
    ["unknown exception references", (candidate: MutablePolicy) => {
      candidate.rules[0]!.exceptions = ["not-a-policy-exception"];
    }, /unknown exception/],
    ["missing prompt labels", (candidate: MutablePolicy) => {
      candidate.rules[0]!.promptLabel = "";
    }, /needs a promptLabel/],
  ])("rejects %s", (_name, mutate, expected) => {
    const candidate = clonePolicy(readPolicy());
    mutate(candidate);
    expect(() => validatePolicy(JSON.stringify(candidate))).toThrow(expected);
  });
});
