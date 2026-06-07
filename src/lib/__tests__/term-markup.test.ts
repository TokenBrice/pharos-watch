import { describe, expect, it } from "vitest";
import { parseTermMarkup, stripTermMarkup } from "@/lib/term-markup";

describe("term markup", () => {
  it("parses glossary markers into text and term segments", () => {
    expect(parseTermMarkup("Backed by {{term:money-market-fund}}MMFs{{/term}} and cash.")).toEqual([
      { type: "text", text: "Backed by " },
      { type: "term", slug: "money-market-fund", label: "MMFs" },
      { type: "text", text: " and cash." },
    ]);
  });

  it("strips markers to their visible labels for non-interactive contexts", () => {
    expect(
      stripTermMarkup(
        "{{term:overcollateralization}}overcollateralized{{/term}} minting with {{term:cdp}}CDP{{/term}} vaults.",
      ),
    ).toBe("overcollateralized minting with CDP vaults.");
  });

  it("leaves malformed markers untouched", () => {
    expect(stripTermMarkup("Broken {{term:cdp}}CDP marker")).toBe("Broken {{term:cdp}}CDP marker");
  });
});
