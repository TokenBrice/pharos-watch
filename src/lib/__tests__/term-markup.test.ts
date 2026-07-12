import { describe, expect, it } from "vitest";
import aiSummaries from "../../../data/ai-summaries.json";
import { GLOSSARY } from "@/lib/glossary";
import { parseTermMarkup, stripTermMarkup } from "@/lib/term-markup";

const KNOWN_SLUGS = new Set(Object.keys(GLOSSARY));

function assertSummaryTermMarkup(summaries: Record<string, { text?: unknown }>) {
  const slugs: string[] = [];
  const rawMarkerIds: string[] = [];
  for (const [id, entry] of Object.entries(summaries)) {
    if (typeof entry.text !== "string") continue;
    slugs.push(...parseTermMarkup(entry.text).flatMap((segment) => (segment.type === "term" ? [segment.slug] : [])));
    const stripped = stripTermMarkup(entry.text);
    if (stripped.includes("{{term:") || stripped.includes("{{/term}}")) rawMarkerIds.push(id);
  }
  const uniqueSlugs = [...new Set(slugs)].sort();
  const unknownSlugs = uniqueSlugs.filter((slug) => !KNOWN_SLUGS.has(slug));
  if (unknownSlugs.length > 0 || rawMarkerIds.length > 0) {
    throw new Error(`invalid term markup: unknown=${unknownSlugs.join(",")} raw=${rawMarkerIds.join(",")}`);
  }
  return { markerCount: slugs.length, uniqueSlugs };
}

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

  it("validates the AI-summary corpus through the runtime parser", () => {
    expect(() => assertSummaryTermMarkup(aiSummaries as Record<string, { text?: unknown }>)).not.toThrow();
  });

  it("rejects unclosed known markers that the old opening-only scan accepted", () => {
    const text = "Broken {{term:cdp}}CDP marker";
    const oldOpeningSlugs = [...text.matchAll(/\{\{term:([a-z0-9-]+)\}\}/g)].map((match) => match[1]);
    expect(oldOpeningSlugs.every((slug) => KNOWN_SLUGS.has(slug))).toBe(true);
    expect(() =>
      assertSummaryTermMarkup({ valid: { text: "{{term:cdp}}CDP{{/term}}" }, broken: { text }, ignored: { text: 42 } }),
    ).toThrow("raw=broken");
    expect(() => assertSummaryTermMarkup({ unknown: { text: "{{term:not-known}}term{{/term}}" } })).toThrow(
      "unknown=not-known",
    );
  });
});
