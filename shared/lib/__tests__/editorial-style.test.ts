import { describe, expect, it } from "vitest";
import {
  EDITORIAL_REGISTER_IDS,
  EDITORIAL_STYLE_HASH,
  EDITORIAL_STYLE_VERSION,
  buildEditorialPrompt,
  editorialRegister,
  formatEditorialFindings,
  hasBlockingEditorialFindings,
  scanEditorialText,
} from "../editorial-style";

const ruleIds = (text: string, register = "daily") =>
  scanEditorialText(text, { register }).map((finding) => finding.ruleId);

const hardIds = (text: string, register = "daily") =>
  scanEditorialText(text, { register })
    .filter((finding) => finding.severity === "hard")
    .map((finding) => finding.ruleId);

describe("editorial style policy", () => {
  it("exposes a version and hash for edition provenance", () => {
    expect(EDITORIAL_STYLE_VERSION).toMatch(/^\d+\.\d+$/);
    expect(EDITORIAL_STYLE_HASH).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects an unknown register instead of silently scanning nothing", () => {
    expect(() => editorialRegister("not-a-register")).toThrow(/Unknown register/);
    expect(EDITORIAL_REGISTER_IDS).toContain("daily");
    expect(EDITORIAL_REGISTER_IDS).toContain("cemetery");
  });
});

describe("hard rules catch real machine tells", () => {
  it("blocks clause dashes", () => {
    expect(hardIds("What it lacks is users \u2014 supply is dust.")).toContain("no-clause-dash");
    expect(hardIds("Supply fell \u2013 the peg held.")).toContain("no-clause-dash");
  });

  it("blocks the corrective cleft within a sentence", () => {
    expect(hardIds("BEDROCK at 95.9 is not complacency, it is what order looks like.")).toContain(
      "no-corrective-cleft",
    );
    expect(hardIds("This isn't a tweak; it's a rebuild.")).toContain("no-corrective-cleft");
  });

  it("treats the cross-sentence split cleft as advisory, not blocking", () => {
    const text = "Three tokens moving together is not a coincidence. It is a preference.";
    expect(ruleIds(text)).toContain("no-corrective-cleft-split");
    expect(hardIds(text)).not.toContain("no-corrective-cleft-split");
  });

  it("does not flag two unrelated factual sentences as a cleft", () => {
    // Real evidence prose from shared/data/stablecoins/domains/mint-authority:
    // a hard match here would have blocked a correct record.
    const evidence =
      "Its governing owner/timelock semantics were not resolved. It is retained as an explicit native parameter-control evidence gap.";
    expect(hardIds(evidence, "technical-evidence")).toHaveLength(0);
  });

  it("blocks stale phrases", () => {
    expect(hardIds("The growth is a testament to demand.")).toContain("no-stale-phrase");
    expect(hardIds("Time will tell whether the peg holds.")).toContain("no-stale-phrase");
  });

  it("blocks investment recommendations anywhere", () => {
    expect(hardIds("We recommend holding the asset.", "coin-summary")).toContain("no-investment-recommendation");
  });
});

describe("closer-scoped rules judge only the ending", () => {
  it("flags a dead closer in final position", () => {
    expect(hardIds("Supply fell 4%.\n\nThe pool is worth watching.")).toContain("no-hedged-closer");
  });

  it("leaves the same phrase alone earlier in the text", () => {
    expect(
      ruleIds("The pool is worth watching, but supply fell 4%. Redemptions cleared at par today."),
    ).not.toContain("no-hedged-closer");
  });
});

describe("false positives that would block correct copy", () => {
  it("never touches signed numeric values", () => {
    expect(ruleIds("PSI moved \u22125% on the day.")).toHaveLength(0);
    expect(ruleIds("Deviation of \u22120.3bps against the peg.")).toHaveLength(0);
  });

  it("still flags a minus used as a clause dash", () => {
    expect(hardIds("Supply fell \u2212 the peg held.")).toContain("no-minus-as-dash");
  });

  it("allows hyphenated ranges, compounds, and identifiers", () => {
    expect(ruleIds("Scores run 0-100 for delta-neutral, yield-bearing designs.")).toHaveLength(0);
  });

  it("allows evidenced contrast and ordinary factual negatives", () => {
    expect(ruleIds("The move reads as repositioning, not growth.")).toHaveLength(0);
    expect(ruleIds("The attestation covers cash, not liabilities.")).toHaveLength(0);
    expect(ruleIds("It is less liquid than USDC at the same depth.")).toHaveLength(0);
  });

  it("leaves the canonical earned epitaph alone", () => {
    expect(scanEditorialText("The magic ran out at nine cents", { register: "cemetery" })).toHaveLength(0);
  });

  it("keeps literal cemetery vocabulary usable in the cemetery", () => {
    const findings = scanEditorialText("The obituary records a seven-week depeg.", {
      register: "cemetery",
      exemptions: ["literal-cemetery"],
    });
    expect(findings.map((finding) => finding.ruleId)).not.toContain("scoped-market-metaphor");
  });

  it("does not mistake the Safe multisig product for a safety claim", () => {
    expect(ruleIds("Control sits with a 3-of-5 Safe held by the issuer.", "coin-summary")).toHaveLength(0);
    expect(ruleIds("A 2-of-6 Safe governs the mint role.", "page-description")).toHaveLength(0);
    expect(hardIds("A safe place to park dollars.", "page-description")).toContain("no-unqualified-safety");
  });

  it("treats quoted and user-owned text as out of scope", () => {
    const quoted = "Regulators called it a game-changing \u2014 revolutionary \u2014 framework.";
    expect(scanEditorialText(quoted, { register: "daily", ownership: "quoted" })).toHaveLength(0);
    expect(scanEditorialText(quoted, { register: "daily", ownership: "user" })).toHaveLength(0);
    expect(scanEditorialText(quoted, { register: "daily" }).length).toBeGreaterThan(0);
  });
});

describe("severity is scoped per register", () => {
  it("keeps decorative words advisory in editorial and silent in technical registers", () => {
    expect(ruleIds("The regulatory landscape shifted in June.", "daily")).toContain("scoped-decorative-word");
    expect(ruleIds("The regulatory landscape shifted in June.", "technical-evidence")).toHaveLength(0);
  });

  it("keeps a warranted qualifier legal in notices", () => {
    expect(ruleIds("Holders may face delayed redemption while the pause is active.", "notice")).toHaveLength(0);
  });

  it("hardens unqualified safety claims only on product surfaces", () => {
    expect(hardIds("A safe place to park dollars.", "page-description")).toContain("no-unqualified-safety");
    expect(hardIds("A safe place to park dollars.", "coin-summary")).not.toContain("no-unqualified-safety");
  });

  it("reports advisory findings without blocking", () => {
    const findings = scanEditorialText("PSI shrugged at the outflow.", { register: "daily" });
    expect(findings.map((finding) => finding.ruleId)).toContain("no-personified-metric");
    expect(hasBlockingEditorialFindings(findings)).toBe(false);
  });
});

describe("prompt derivation", () => {
  it("renders the directive, register line, and both rule classes", () => {
    const prompt = buildEditorialPrompt("daily");
    expect(prompt).toContain("FT markets reporter");
    expect(prompt).toContain("REGISTER: Daily editorial.");
    expect(prompt).toContain("NEVER (a violation blocks publication):");
    expect(prompt).toContain("AVOID (reviewed, not blocking):");
  });

  it("varies the blocking set by register", () => {
    expect(buildEditorialPrompt("page-description")).toContain("unqualified safety claims");
    expect(buildEditorialPrompt("technical-evidence")).not.toContain("decorative uses of");
  });

  it("formats findings with rule, field, and excerpt for a corrective retry", () => {
    const findings = scanEditorialText("Supply fell \u2014 the peg held.", { register: "daily", field: "extended" });
    const formatted = formatEditorialFindings(findings);
    expect(formatted).toContain("[no-clause-dash]");
    expect(formatted).toContain("extended:");
    expect(hasBlockingEditorialFindings(findings)).toBe(true);
  });
});
