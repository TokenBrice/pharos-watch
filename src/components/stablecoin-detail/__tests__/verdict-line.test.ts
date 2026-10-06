import { describe, expect, it } from "vitest";
import { countSummaryWords } from "@shared/lib/summary-budget";
import { deriveVerdictLine } from "../verdict-line";

describe("deriveVerdictLine", () => {
  it("returns the first sentence when it fits the verdict budget", () => {
    expect(deriveVerdictLine("Reserves sit in segregated accounts. Rehypothecation is prohibited.")).toBe(
      "Reserves sit in segregated accounts.",
    );
  });

  it("does not split on abbreviations or initials", () => {
    expect(deriveVerdictLine("Held in U.S. Treasury bills at a regulated custodian. Second sentence.")).toBe(
      "Held in U.S. Treasury bills at a regulated custodian.",
    );
  });

  it("falls back to the first clause when the sentence is over budget", () => {
    const long = `The issuer controls minting through a managed owner contract; ${"extra detail ".repeat(20)}ends here.`;
    const verdict = deriveVerdictLine(long);
    expect(verdict).toBe("The issuer controls minting through a managed owner contract.");
    expect(countSummaryWords(verdict!)).toBeLessThanOrEqual(25);
  });

  it("refuses a sentence carrying raw identifiers and no clean clause", () => {
    expect(deriveVerdictLine("Measured at block 25,711,857 via eth_call on the proxy.")).toBeNull();
    expect(deriveVerdictLine("0x7546762fdb1a6d9146b33960545c3f6394265219 is a minter.")).toBeNull();
  });

  it("returns null for empty text", () => {
    expect(deriveVerdictLine("   ")).toBeNull();
  });
});
