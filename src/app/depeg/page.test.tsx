import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEPEG_PENDING_MIN_AGE_SEC } from "@shared/lib/depeg-config";
import { METHODOLOGY_CONTEXT } from "@/lib/methodology-context";
import DepegPage, { metadata } from "./page";

const { EVENTS } = vi.hoisted(() => ({
  EVENTS: [
    { slug: "disputed", provenance: { auditVerdict: "disputed" } },
    { slug: "false-positive", provenance: { auditVerdict: "false_positive" } },
    { slug: "confirmed", provenance: { auditVerdict: "confirmed" } },
    { slug: "legacy", provenance: null },
  ],
}));

vi.mock("@/lib/depeg-event-page-data", () => ({ DEPEG_EVENT_ENTRIES: EVENTS }));
vi.mock("./client", () => ({ DepegClient: () => <div>depeg client</div>, default: () => <div>depeg client</div> }));
vi.mock("./depeg-event-archive", () => ({ DepegEventArchivePreview: () => null }));

const QUESTION = "What counts as a depeg event on Pharos?";
const ANSWER = "A depeg event is triggered when a stablecoin's price deviates from its peg by more than 1% (100 bps) for USD-pegged coins, or 1.5% (150 bps) for non-USD pegs. Every new event is pending at first: the deviation must hold for at least 15 minutes and be backed by a trusted or multi-source primary price, or by same-direction secondary evidence, before it is confirmed. Opposite-direction evidence never counts as confirmation and can reject a pending event.";

describe("depeg FAQ pending confirmation", () => {
  it("states universal pending confirmation identically in visible copy and FAQPage JSON-LD", () => {
    expect(DEPEG_PENDING_MIN_AGE_SEC / 60).toBe(15);
    const html = renderToStaticMarkup(<DepegPage />);
    const jsonLd = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]!.replace(/\\u003c/g, "<")))
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find((value) => value["@type"] === "FAQPage");
    const entry = jsonLd?.mainEntity.find((item: { name: string }) => item.name === QUESTION);
    expect(entry?.acceptedAnswer.text).toBe(ANSWER);
    expect(html).toContain(ANSWER.replace(/'/g, "&#x27;"));
    expect(html).not.toMatch(/opens events immediately|rejects the pending incident instead/);
  });

  it("states the PegScore tracking gate without a retired early-score label", () => {
    const html = renderToStaticMarkup(<DepegPage />);
    const jsonLd = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]!.replace(/\\u003c/g, "<")))
      .flatMap((value) => (Array.isArray(value) ? value : [value]))
      .find((value) => value["@type"] === "FAQPage");
    const entry = jsonLd?.mainEntity.find((item: { name: string }) => item.name === "How is the peg score calculated?");
    expect(entry?.acceptedAnswer.text).toContain("fewer than 7 days of tracking history");
    expect(entry?.acceptedAnswer.text).toContain("historyCoverage");
    expect(entry?.acceptedAnswer.text).not.toMatch(/Early score/i);
  });

  it("describes only non-disputed recorded events in the route metadata", () => {
    expect(metadata.description).toContain("2 recorded depeg events");
  });

  it("keeps the contextual help line consistent with the FAQ minimum", () => {
    expect(METHODOLOGY_CONTEXT.activeDepegs.detail)
      .toBe("Every new depeg must hold for at least 15 minutes and pass source-trust checks before it counts as live.");
  });
});
