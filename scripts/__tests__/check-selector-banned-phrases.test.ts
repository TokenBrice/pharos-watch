import { describe, expect, it } from "vitest";

import { collectFiles, scanSource } from "../ci/check-selector-banned-phrases.mjs";

function rulesFor(source: string): string[] {
  return scanSource("/tmp/selector-copy.tsx", source).map((finding) => finding.rule);
}

describe("check-selector-banned-phrases", () => {
  it("flags the Selector hold-safely phrasing", () => {
    expect(rulesFor('label: "Hold safely (Treasury)"')).toContain("Hold safely");
  });

  it("flags visible raw whyKey and reasonKey fallbacks", () => {
    const rules = rulesFor(`
      <p>Profile-conditioned signals: {rec.whyKeys.slice(0, 2).join(", ")}.</p>
      const verdict = \`\${entry.symbol} — \${entry.reasonKey}\`;
    `);

    expect(rules).toContain("Raw whyKey join fallback");
    expect(rules).toContain("Raw reasonKey interpolation fallback");
  });

  it("does not flag key declarations or editorial references by themselves", () => {
    const rules = rulesFor(`
      export const keys = ["top-safety", "strong-resilience", "weak-liquidity"];
      const reasonKey = "weak-safety";
      const text = "Safety Score can be discussed safely, but not as a safe coin claim";
    `);

    expect(rules).toContain("Safe (unqualified)");
    expect(rules).not.toContain("Raw whyKey join fallback");
    expect(rules).not.toContain("Raw reasonKey interpolation fallback");
  });

  it("honors the one-line allow marker", () => {
    expect(rulesFor('"Hold safely" // banned-phrase-allow: policy example')).toEqual([]);
  });

  it("fails when a required scan target is missing", async () => {
    await expect(collectFiles({ kind: "file", path: "missing-selector-copy.md" })).rejects.toThrow(
      "required scan target missing: missing-selector-copy.md",
    );
  });
});
