// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const { EVENTS, EVENTS_BY_SLUG, RECOVERED_EVENT } = vi.hoisted(() => {
  const base = {
    stablecoinId: "usdc-circle",
    symbol: "USDC",
    pegType: "peggedUSD",
    direction: "below" as const,
    peakDeviationBps: 1_200,
    startedAt: 1_733_000_000,
    endedAt: 1_733_003_600,
    startPrice: 0.99,
    peakPrice: 0.98,
    recoveryPrice: 1,
    pegReference: 1,
    source: "live" as const,
    confirmationSources: null,
    pendingReason: null,
    closeReason: null,
  };
  const recovered = {
    ...base, id: 4, slug: "recovered-event", provenance: null, closeReason: "recovered-primary" as const,
    endedAt: base.startedAt + 1800, analyticRecoveryAt: base.startedAt + 900,
  };
  const events = [
    { ...base, id: 1, slug: "disputed-event", provenance: { auditVerdict: "disputed" as const, confidenceTier: "high" } },
    { ...base, id: 2, slug: "confirmed-event", provenance: { auditVerdict: "confirmed" as const }, admittedCoverage: [
      { fromSec: base.startedAt, toSec: base.startedAt + 1_200 },
      { fromSec: base.startedAt + 2_400, toSec: base.endedAt },
    ] },
    { ...base, id: 3, slug: "ongoing-event", endedAt: null, recoveryPrice: null, provenance: null },
    recovered,
  ];
  return { EVENTS: events, EVENTS_BY_SLUG: new Map(events.map((event) => [event.slug, event])), RECOVERED_EVENT: recovered };
});

const resolver = vi.hoisted(() => ({ data: undefined as unknown }));
vi.mock("@/hooks/api-hooks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/api-hooks")>()),
  useDepegResolver: () => ({ data: resolver.data, error: null }),
}));
const flags = vi.hoisted(() => ({ resolver: true }));
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags")>()),
  isDepegResolverEnabled: () => flags.resolver,
}));

vi.mock("@/lib/depeg-event-page-data", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/depeg-event-page-data")>();
  const events = [...actual.DEPEG_EVENT_ENTRIES, ...EVENTS];
  return {
    ...actual,
    DEPEG_EVENT_ENTRIES: events,
    eventBySlug: new Map<string, unknown>([...actual.eventBySlug, ...EVENTS_BY_SLUG]),
    formatIncidentNumber: () => null,
  };
});

vi.mock("@/lib/page-metadata", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/page-metadata")>();
  // Synthetic fixture events have no generated preview; real slugs still resolve strictly.
  return {
    ...actual,
    getPageSocialPreview: (canonical: string) =>
      actual.getPageSocialPreview(/\/depeg\/(?:disputed|confirmed|ongoing|recovered)-event\/$/.test(canonical) ? "/depeg/" : canonical),
  };
});

vi.mock("next/font/local", () => ({
  default: () => ({ className: "mock-local-font", variable: "--mock-local-font" }),
}));

vi.mock("@/components/related-incidents-rail", () => ({ RelatedIncidentsRail: () => null }));
vi.mock("@/components/preferred-source-prompt", () => ({ PreferredSourcePrompt: () => null }));
vi.mock("@/hooks/use-prefetch-stablecoin", () => ({ usePrefetchStablecoin: () => vi.fn() }));

import DepegEventPage, { generateMetadata } from "./page";
import { DepegFeed } from "@/components/depeg/depeg-feed";
import { installMatchMediaMock } from "@/test-utils/frontend";
import { COLLIDING_DEPEG_EVENT_SLUGS, DEPEG_EVENT_ENTRIES } from "@/lib/depeg-event-page-data";
import { buildDepegEventDescription, buildDepegEventSynopsis } from "@/lib/depeg-event-display";
import { TRACKED_META_BY_ID } from "@shared/lib/stablecoins/registry";
import { DDR_TEST_META, makeDdrSourceRow, makeFrozenDdrV2Row } from "@/components/depeg-resolver-test-support";

async function renderPage(slug: string) {
  const tree = await DepegEventPage({ params: Promise.resolve({ event: slug }) });
  return render(tree);
}

function provenanceLine(): HTMLElement {
  return screen.getByText(/Detected under/).closest("p")!;
}

describe("DepegEventPage provenance audit verdict", () => {
  it("prepends the shared Disputed pill and drops the raw audit token", async () => {
    await renderPage("disputed-event");

    const line = provenanceLine();
    expect(within(line).getByText("Disputed")).toBeTruthy();
    expect(line.textContent).not.toMatch(/audit:/i);
  });

  it("leaves other verdicts as the existing raw audit token", async () => {
    await renderPage("confirmed-event");

    const line = provenanceLine();
    expect(within(line).queryByText("Disputed")).toBeNull();
    expect(line.textContent).toContain("audit: confirmed");
  });
});

describe("ongoing event Now strip", () => {
  it("leads an open event with the resolver's live state", async () => {
    resolver.data = { _meta: DDR_TEST_META, rows: [makeFrozenDdrV2Row(makeDdrSourceRow({ stablecoinId: "usdc-circle", symbol: "USDC", eventId: 3, currentDeviationBps: -4_510 }))] };
    await renderPage("ongoing-event");
    const strip = screen.getByRole("region", { name: "USDC live state" });
    for (const text of ["45.1% below peg", "Stress signals"]) expect(strip.textContent).toContain(text);
    expect(within(strip).getByRole("link").getAttribute("href")).toBe("/stablecoin/usdc-circle#depeg-resolver");
    resolver.data = { _meta: DDR_TEST_META, rows: [] };
    await renderPage("ongoing-event");
    expect(screen.getAllByRole("region", { name: "USDC live state" })[1].textContent).toContain("No live resolver row for this incident");
  });

  it("adds no live strip to a resolved event, nor while the resolver is off", async () => {
    await renderPage("confirmed-event");
    flags.resolver = false;
    await renderPage("ongoing-event").finally(() => { flags.resolver = true; });
    expect(screen.queryByRole("region", { name: /live state/ })).toBeNull();
  });
});

describe("depeg event page metadata and briefing", () => {
  it("qualifies the BRZ peak in search and social metadata", async () => {
    const metadata = await generateMetadata({ params: Promise.resolve({ event: "brz-2023-02-07" }) });
    expect(metadata.description).toContain("peak unverified");
    expect(metadata.openGraph?.description).toContain("peak unverified");
    expect(metadata.twitter?.description).toContain("peak unverified");
    expect(metadata.robots).toMatchObject({ index: false, follow: true });
  });

  it("labels recorded duration and shows both timestamps when admitted coverage starts on time but has a gap", async () => {
    const html = renderToStaticMarkup(await DepegEventPage({ params: Promise.resolve({ event: "confirmed-event" }) }));
    expect(html).toContain("Recorded detector start");
    expect(html).toContain("First admissible observation");
    expect(html).toContain("Recorded duration");
  });

  it("uses the admitted recovery time for the permanent record and recent feed", async () => {
    await renderPage(RECOVERED_EVENT.slug);
    expect(screen.getByText("Duration").nextElementSibling?.textContent).toBe("15 min");

    installMatchMediaMock(true);
    const { container } = render(<DepegFeed events={[
      RECOVERED_EVENT,
      { ...RECOVERED_EVENT, id: 5, symbol: "LEGACY", analyticRecoveryAt: undefined },
      { ...RECOVERED_EVENT, id: 6, symbol: "UNVERIFIED", analyticRecoveryAt: null },
    ]} />);
    expect(within(container).getByRole("link", { name: /USDC.*15m/ })).toBeTruthy();
    expect(within(container).getByRole("link", { name: /LEGACY.*30m/ })).toBeTruthy();
    expect(within(container).getByRole("link", { name: /UNVERIFIED.*Recorded duration 30m/ })).toBeTruthy();
  });

  it.each(["kag-2026-06-14", "eurr-2026-05-24"])("qualifies the legacy detector start for %s", async (event) => {
    const params = Promise.resolve({ event });
    const html = renderToStaticMarkup(await DepegEventPage({ params }));
    const article = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]))
      .find((entry) => entry["@type"] === "NewsArticle");
    expect(article).toBeDefined();
    expect(article).not.toHaveProperty("datePublished");
    expect(html).toContain("Recorded detector start");
    expect(html).toContain("First admissible observation");
    expect(html).toContain("no admissible onset is documented");
  });

  it("qualifies a disputed audit verdict in metadata without dropping the measured deviation", async () => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.provenance?.auditVerdict === "disputed")!;
    expect(event).toBeDefined();

    const metadata = await generateMetadata({ params: Promise.resolve({ event: event.slug }) });
    expect(metadata.description).toContain("(Disputed)");
  });

  it.each(["tryb-2026-06-23", "usdr-2026-06-21"])("uses the same coverage-loss description in metadata and JSON-LD for %s", async (slug) => {
    const event = DEPEG_EVENT_ENTRIES.find((entry) => entry.slug === slug)!;
    const params = Promise.resolve({ event: slug });
    const metadata = await generateMetadata({ params });
    const coinName = TRACKED_META_BY_ID.get(event.stablecoinId)?.name ?? null;
    const description = buildDepegEventDescription(event, COLLIDING_DEPEG_EVENT_SLUGS.has(slug), coinName);
    expect(metadata.description).toBe(description);
    // Social copy is evergreen and separate from SEO copy, but never contradicts the closure.
    expect(metadata.openGraph?.description).toMatch(/coverage lost/i);
    expect(description).toMatch(/coverage lost/i);
    expect(description).not.toMatch(/\brecovered\b/i);
    const html = renderToStaticMarkup(await DepegEventPage({ params }));
    const articles = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]))
      .filter((entry) => entry["@type"] === "NewsArticle");
    expect(articles).toHaveLength(1);
    expect(articles[0].description).toBe(description);
    expect(html).toContain(buildDepegEventSynopsis(event));
  });
});

describe("depeg event editorial rendering", () => {
  it.each([
    ["usdc-2023-03-11", true],
    ["tryb-2026-06-23", false],
  ] as const)("renders a briefing only for authored event %s", async (slug, authored) => {
    const html = renderToStaticMarkup(await DepegEventPage({ params: Promise.resolve({ event: slug }) }));
    expect(/<article aria-label="[^"]+ depeg briefing"/.test(html)).toBe(authored);
  });

  it("reconciles the USDC briefing, annotation and source with the recorded observation", async () => {
    const html = renderToStaticMarkup(await DepegEventPage({ params: Promise.resolve({ event: "usdc-2023-03-11" }) }));
    const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "\u2019").replace(/\s+/g, " ");
    expect(text).toContain("USDC fell 12.1% below peg in Pharos\u2019s record.");
    for (const figure of ["$0.9841", "$0.8789", "$0.9937", "March 12", "March 13"]) expect(text).toContain(figure);
    for (const retired of ["13-cent", "13.0%", "Sunday low", "largest ever", "cash backing", "parity again"]) {
      expect(text).not.toContain(retired);
    }
    const annotations = JSON.parse(readFileSync(resolve(process.cwd(), "shared/data/annotations/coins/usdc-circle.json"), "utf8")) as
      Array<{ date: string; label: string; href?: string }>;
    const pin = annotations.find((entry) => entry.date === "2023-03-11")!;
    expect(pin).toBeDefined();
    // The page surfaces the reviewed annotation verbatim instead of re-copying it.
    expect(pin.label.length).toBeGreaterThan(0);
    expect(text).toContain(pin.label);
    expect(pin.href).toMatch(/^https:\/\//);
    expect(html).toContain(pin.href!);
  });
});
