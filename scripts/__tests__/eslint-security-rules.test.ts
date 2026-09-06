import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// DependencyAudit-1 regression: security/detect-non-literal-fs-filename is off
// globally (the scripts/** carve-out and its ~101 inline suppressions were
// removed by owner review), while the regex and timing rules stay active on
// every linted surface. Lints an in-memory snippet only — no fixture files.
const eslint = new ESLint({ cache: false, cwd: process.cwd(), overrideConfigFile: "eslint.config.mjs" });

// Exercises all four rules: dynamic fs path, unsafe regex, non-literal RegExp,
// and a sensitive-name equality comparison.
const PROBE = `import { readFileSync } from "node:fs";
const target = process.argv[2] ?? "data.json";
const content = readFileSync(target, "utf8");
const unsafe = /(a+)+$/;
const dynamic = new RegExp(target);
const secret = process.env.PROBE_TOKEN ?? "";
if (secret === content) console.log("match");
console.log(unsafe, dynamic);
`;

// .mts sat outside the old scripts/**/*.{mjs,ts} carve-out; .mjs/.ts inside it;
// the rest cover the runtime surfaces where the rule used to fire.
const PROBE_PATHS = [
  "scripts/lib/__security-probe.mts",
  "scripts/__security-probe.mjs",
  "scripts/__security-probe.ts",
  "worker/src/__security-probe.ts",
  "src/lib/__security-probe.ts",
  "shared/lib/__security-probe.ts",
];

const RETAINED_RULES = [
  "security/detect-unsafe-regex",
  "security/detect-non-literal-regexp",
  "security/detect-possible-timing-attacks",
];

describe("ESLint security rules", () => {
  it("disables detect-non-literal-fs-filename everywhere while regex and timing rules keep firing", async () => {
    for (const filePath of PROBE_PATHS) {
      const [result] = await eslint.lintText(PROBE, { filePath });
      const ruleIds = result.messages.map((message) => message.ruleId);
      expect(ruleIds, `${filePath} must not report the fs-filename rule`).not.toContain(
        "security/detect-non-literal-fs-filename",
      );
      for (const ruleId of RETAINED_RULES) {
        expect(ruleIds, `${filePath} must still report ${ruleId}`).toContain(ruleId);
      }
    }
  });
});
