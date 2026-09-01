/**
 * Compiles the machine-readable policy block in `docs/editorial-style.md` into
 * `shared/lib/editorial-style.generated.ts`.
 *
 * The Markdown document is the sole authored authority: prose rules and the
 * fenced `editorial-policy` JSON live side by side so a prompt line can never
 * drift from the regex that enforces it. This generator only serializes data.
 * It never emits executable logic, and the runtime facade
 * (`shared/lib/editorial-style.ts`) is hand-written.
 *
 * Validation is deliberately strict: an invalid regex or an unknown register
 * reference in the fence would otherwise reach the digest hard gate and block a
 * production edition. Every failure here is a build failure.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EDITORIAL_POLICY as GENERATED_EDITORIAL_POLICY } from "../../shared/lib/editorial-style.generated";
import { syncGeneratedArtifacts } from "../lib/generated-artifacts";
import { isDirectRun } from "../lib/smoke-runtime.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOC_PATH = join(__dirname, "../../docs/editorial-style.md");
const OUTPUT = join(__dirname, "../../shared/lib/editorial-style.generated.ts");
const CHECK_MODE = process.argv.includes("--check");

const FENCE_RE = /```json editorial-policy\n([\s\S]*?)\n```/;
const REGISTER_GROUPS: Record<string, true> = { editorial: true, technical: true, product: true };
const SEVERITIES: Record<string, true> = { hard: true, advisory: true, off: true };
const KNOWN_EXCEPTIONS: Record<string, true> = {
  "quoted-source": true,
  "external-title": true,
  code: true,
  identifier: true,
  "numeric-sign": true,
  "legal-term": true,
  "literal-cemetery": true,
  table: true,
};

interface PolicyPattern {
  source: string;
  flags: string;
}

interface PolicyRule {
  id: string;
  promptLabel: string;
  patterns: PolicyPattern[];
  severity: { default: string; byRegister?: Record<string, string> };
  closerOnly?: boolean;
  exceptions?: string[];
  replacementAdvice?: string;
  introducedIn: string;
  examples: { violating: string[]; clean: string[] };
}

interface PolicyRegister {
  id: string;
  label: string;
  group: string;
  promptLine: string;
}

export interface Policy {
  version: string;
  oneLineDirective: string;
  registers: PolicyRegister[];
  rules: PolicyRule[];
}

function numericVersion(version: string): number {
  return Number(version);
}

export function extractPolicyBlock(markdown: string): string {
  const match = FENCE_RE.exec(markdown);
  if (!match?.[1]) {
    throw new Error(
      "[editorial-style] No ```json editorial-policy fence found in docs/editorial-style.md.",
    );
  }
  if (FENCE_RE.exec(markdown.slice(match.index + match[0].length))) {
    throw new Error("[editorial-style] Multiple editorial-policy fences found; exactly one is allowed.");
  }
  return match[1];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[editorial-style] ${message}`);
}

export function validatePolicy(raw: string): Policy {
  let parsed: Policy;
  try {
    parsed = JSON.parse(raw) as Policy;
  } catch (error) {
    throw new Error(`[editorial-style] Policy block is not valid JSON: ${(error as Error).message}`);
  }

  assert(
    // eslint-disable-next-line security/detect-unsafe-regex -- anchored finite version shape over the checked-in policy fence.
    typeof parsed.version === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9](?:\d*[1-9])?)$/.test(parsed.version),
    "version must be an unambiguous MAJOR.MINOR number.",
  );
  assert(
    typeof parsed.oneLineDirective === "string" && parsed.oneLineDirective.trim().length > 0,
    "oneLineDirective must be a non-empty string.",
  );
  assert(Array.isArray(parsed.registers) && parsed.registers.length > 0, "registers must be a non-empty array.");
  assert(Array.isArray(parsed.rules) && parsed.rules.length > 0, "rules must be a non-empty array.");

  const registerIds = new Set<string>();
  for (const register of parsed.registers) {
    assert(typeof register.id === "string" && register.id.length > 0, "register.id must be a non-empty string.");
    assert(!registerIds.has(register.id), `Duplicate register id "${register.id}".`);
    registerIds.add(register.id);
    assert(typeof register.label === "string" && register.label.length > 0, `register "${register.id}" needs a label.`);
    assert(REGISTER_GROUPS[register.group] === true, `register "${register.id}" has unknown group "${register.group}".`);
    assert(
      typeof register.promptLine === "string" && register.promptLine.trim().length > 0,
      `register "${register.id}" needs a promptLine.`,
    );
  }

  const ruleIds = new Set<string>();
  for (const rule of parsed.rules) {
    assert(typeof rule.id === "string" && rule.id.length > 0, "rule.id must be a non-empty string.");
    assert(!ruleIds.has(rule.id), `Duplicate rule id "${rule.id}".`);
    ruleIds.add(rule.id);
    assert(
      typeof rule.promptLabel === "string" && rule.promptLabel.trim().length > 0,
      `rule "${rule.id}" needs a promptLabel; an enforceable rule must be expressible to a model.`,
    );
    assert(Array.isArray(rule.patterns) && rule.patterns.length > 0, `rule "${rule.id}" needs at least one pattern.`);
    for (const pattern of rule.patterns) {
      assert(
        typeof pattern.source === "string" && pattern.source.length > 0,
        `rule "${rule.id}" has a pattern without a source.`,
      );
      assert(
        typeof pattern.flags === "string" && /^[gimsuy]*$/.test(pattern.flags),
        `rule "${rule.id}" has invalid flags "${pattern.flags}".`,
      );
      assert(pattern.flags.includes("g"), `rule "${rule.id}" patterns must be global so every match is reported.`);
      try {
        // eslint-disable-next-line security/detect-non-literal-regexp -- validating the authored policy fence's own patterns at build time.
        new RegExp(pattern.source, pattern.flags);
      } catch (error) {
        throw new Error(
          `[editorial-style] rule "${rule.id}" has an uncompilable pattern /${pattern.source}/${pattern.flags}: ${(error as Error).message}`,
        );
      }
    }
    assert(rule.severity != null && typeof rule.severity === "object", `rule "${rule.id}" needs a severity object.`);
    assert(
      SEVERITIES[rule.severity.default] === true,
      `rule "${rule.id}" has unknown default severity "${rule.severity.default}".`,
    );
    for (const [register, severity] of Object.entries(rule.severity.byRegister ?? {})) {
      assert(registerIds.has(register), `rule "${rule.id}" references unknown register "${register}".`);
      assert(SEVERITIES[severity] === true, `rule "${rule.id}" has unknown severity "${severity}" for "${register}".`);
    }
    for (const exception of rule.exceptions ?? []) {
      assert(KNOWN_EXCEPTIONS[exception] === true, `rule "${rule.id}" references unknown exception "${exception}".`);
    }
    assert(
      rule.closerOnly === undefined || typeof rule.closerOnly === "boolean",
      `rule "${rule.id}" closerOnly must be boolean.`,
    );
    assert(
      // eslint-disable-next-line security/detect-unsafe-regex -- anchored finite version shape over the checked-in policy fence.
      typeof rule.introducedIn === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9](?:\d*[1-9])?)$/.test(rule.introducedIn),
      `rule "${rule.id}" needs an unambiguous MAJOR.MINOR introducedIn version.`,
    );
    assert(
      numericVersion(rule.introducedIn) <= numericVersion(parsed.version),
      `rule "${rule.id}" introducedIn ${rule.introducedIn} exceeds policy version ${parsed.version}.`,
    );
    assert(rule.examples != null && typeof rule.examples === "object", `rule "${rule.id}" needs examples.`);
    assert(
      Array.isArray(rule.examples.violating) && rule.examples.violating.length > 0,
      `rule "${rule.id}" needs at least one violating example.`,
    );
    assert(Array.isArray(rule.examples.clean), `rule "${rule.id}" examples.clean must be an array.`);
    for (const example of [...rule.examples.violating, ...rule.examples.clean]) {
      assert(
        typeof example === "string" && example.trim().length > 0,
        `rule "${rule.id}" examples must be non-empty strings.`,
      );
    }
  }

  return parsed;
}

/** Stable stringification so the hash tracks meaning, not key order or whitespace. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
  return `{${entries.join(",")}}`;
}

export function policyHash(policy: Policy): string {
  return createHash("sha256").update(canonicalize(policy)).digest("hex").slice(0, 16);
}

export function assertMonotonicPolicyVersion(current: Policy, next: Policy): void {
  const currentVersion = numericVersion(current.version);
  const nextVersion = numericVersion(next.version);
  assert(
    nextVersion >= currentVersion,
    `policy version ${next.version} cannot be lower than generated version ${current.version}.`,
  );

  const changed = canonicalize(current) !== canonicalize(next);
  assert(
    !changed || nextVersion > currentVersion,
    `semantic policy changes require a version above generated version ${current.version}.`,
  );

  if (nextVersion > currentVersion) {
    const currentRules = new Map(current.rules.map((rule) => [rule.id, rule]));
    for (const rule of next.rules) {
      const previous = currentRules.get(rule.id);
      if (!previous) {
        assert(
          rule.introducedIn === next.version,
          `new rule "${rule.id}" must set introducedIn to policy version ${next.version}.`,
        );
      } else {
        assert(
          rule.introducedIn === previous.introducedIn,
          `existing rule "${rule.id}" must keep introducedIn ${previous.introducedIn}.`,
        );
      }
    }
  }
}

export function renderModule(policy: Policy): string {
  const hash = policyHash(policy);
  return [
    "// Generated by scripts/maintenance/generate-editorial-style.ts from the",
    "// `editorial-policy` fence in docs/editorial-style.md. Do not edit by hand:",
    "// edit the document and regenerate. Serialized data only, no logic.",
    'import type { EditorialPolicy } from "./editorial-style";',
    "",
    `export const EDITORIAL_STYLE_VERSION = ${JSON.stringify(policy.version)};`,
    "",
    "/** Deterministic hash of the policy block. Bumps whenever enforcement changes. */",
    `export const EDITORIAL_STYLE_HASH = ${JSON.stringify(hash)};`,
    "",
    `export const EDITORIAL_POLICY: EditorialPolicy = ${JSON.stringify(policy, null, 2)} as const;`,
    "",
  ].join("\n");
}

function main(): void {
  const policy = validatePolicy(extractPolicyBlock(readFileSync(DOC_PATH, "utf8")));
  assertMonotonicPolicyVersion(GENERATED_EDITORIAL_POLICY as Policy, policy);
  syncGeneratedArtifacts({
    artifacts: [{ path: OUTPUT, contents: renderModule(policy) }],
    check: CHECK_MODE,
    staleMessage:
      "shared/lib/editorial-style.generated.ts is out of date. Run `node --import tsx scripts/maintenance/generate-editorial-style.ts`.",
    currentMessage: "Editorial style policy is current",
    writtenMessage: "Generated editorial style policy",
  });
}

if (isDirectRun(import.meta.url, process.argv[1])) {
  main();
}
