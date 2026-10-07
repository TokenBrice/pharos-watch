// @vitest-environment jsdom
// src/components/stablecoin-detail/__tests__/regulatory-standing-card.test.tsx
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { GeniusProfile, MicaProfile, StablecoinMeta } from "@shared/types";
import { RegulatoryStandingCard } from "../regulatory-standing-card";
import {
  buildRegulatoryStandingView,
  ISSUER_DISCLOSURES,
  type RegulatoryStandingView,
} from "@/lib/regulatory-standing";
import { SEVERITY_TONE_CLASS } from "@/lib/severity-tone";

const GENIUS: GeniusProfile = {
  applicability: "apparent-payment-stablecoin",
  authorizationStatus: "official-application-pending",
  issuerPathway: "federal-qualified-nonbank",
  primaryFederalRegulator: "OCC",
  monthlyAttestationPresent: true,
  redemptionPolicyPresent: false,
  reserveDisclosurePresent: undefined,
  notes: "Reviewer narrative.",
  references: [{ label: "OCC filing", url: "https://example.com/occ", sourceKind: "federal-regulator" }],
  reviewer: "test",
  reviewedAt: "2026-07-02",
};

const MICA: MicaProfile = {
  status: "non-compliant",
  tokenType: "ART",
  references: [{ label: "ESMA register", url: "https://example.com/esma" }],
};

/** A GENIUS review that found the token outside the Act: not a regime that applies. */
const OUT_OF_SCOPE_GENIUS: GeniusProfile = {
  ...GENIUS,
  applicability: "non-payment-token",
  authorizationStatus: "not-applicable",
};

function buildView(coin: {
  genius?: GeniusProfile;
  mica?: MicaProfile;
  proofOfReserves?: StablecoinMeta["proofOfReserves"];
}): RegulatoryStandingView {
  const view = buildRegulatoryStandingView({ symbol: "TUSD", ...coin });
  if (!view) throw new Error("fixture must resolve a view");
  return view;
}

function terms(): HTMLElement[] {
  return Array.from(document.body.querySelectorAll<HTMLElement>("dt"));
}

/** The term/description pair whose term names `label`, in whichever description list holds it. */
function definition(label: string): { term: HTMLElement; value: HTMLElement } {
  const term = terms().find((candidate) => candidate.textContent?.includes(label));
  expect(term).toBeDefined();
  const value = term!.nextElementSibling as HTMLElement | null;
  expect(value?.tagName).toBe("DD");
  return { term: term!, value: value! };
}

function hasToneClass(element: Element | null, toneClass: string): boolean {
  const tokens = toneClass.split(/\s+/);
  for (let node = element; node; node = node.parentElement) {
    const { classList } = node;
    if (tokens.every((token) => classList.contains(token))) return true;
  }
  return false;
}

afterEach(cleanup);

describe("RegulatoryStandingCard", () => {
  const [attestation, redemptionPolicy, reserveDisclosure] = ISSUER_DISCLOSURES;

  it("keeps regime rows to status and pathway, with issuer disclosures in their own labelled row", () => {
    const view = buildView({ genius: GENIUS, mica: MICA });
    render(<RegulatoryStandingCard view={view} />);

    for (const regime of view.regimes) {
      const { value } = definition(regime.regimeLabel);
      expect(value.textContent).toContain(regime.status.label);
      if (regime.caption) expect(value.textContent).toContain(regime.caption);
      // No disclosure state is drawn as a regime cell.
      expect(value.querySelector("svg")).toBeNull();
      for (const disclosure of ISSUER_DISCLOSURES) expect(value.textContent).not.toContain(disclosure.label);
    }
    expect(screen.getByText("Issuer disclosures")).toBeTruthy();
    for (const disclosure of ISSUER_DISCLOSURES) expect(definition(disclosure.label).value).toBeTruthy();
  });

  it("never draws a compliance tick: published disclosures beside a 'None found' status are neutral", () => {
    const view = buildView({
      genius: {
        ...GENIUS,
        authorizationStatus: "no-public-authorization-found",
        monthlyAttestationPresent: true,
        redemptionPolicyPresent: true,
        reserveDisclosurePresent: true,
      },
      mica: { ...MICA, status: "authorized" },
    });
    render(<RegulatoryStandingCard view={view} />);

    const genius = definition("GENIUS (US)").value;
    expect(genius.textContent).toContain("None found");
    expect(genius.querySelector("svg")).toBeNull();
    for (const disclosure of ISSUER_DISCLOSURES) {
      const tick = definition(disclosure.label).value.querySelector("svg");
      expect(tick).not.toBeNull();
      expect(hasToneClass(tick, SEVERITY_TONE_CLASS.ok.text)).toBe(false);
    }
  });

  it("renders an unrecorded disclosure as unavailable rather than failed", () => {
    render(<RegulatoryStandingCard view={buildView({ genius: GENIUS })} />);

    const published = definition(attestation!.label).value;
    const failed = definition(redemptionPolicy!.label).value;
    const unrecorded = definition(reserveDisclosure!.label).value;

    // Only a published disclosure draws the tick; the others read their state in words.
    expect(published.querySelector("svg")).not.toBeNull();
    expect(failed.querySelector("svg")).toBeNull();
    expect(unrecorded.querySelector("svg")).toBeNull();
    expect(new Set([published.textContent, failed.textContent, unrecorded.textContent]).size).toBe(3);
    expect(hasToneClass(unrecorded.firstElementChild, SEVERITY_TONE_CLASS.watch.text)).toBe(false);
  });

  it("reads a named attestor's slow cadence as a watch gap, never as 'Not found'", () => {
    render(
      <RegulatoryStandingCard
        view={buildView({
          genius: { ...GENIUS, monthlyAttestationPresent: false, redemptionPolicyPresent: false },
          proofOfReserves: {
            type: "attestation",
            url: "https://example.com/transparency",
            provider: "BDO Italia",
            attestorTier: "regional",
            cadence: "quarterly",
          },
        })}
      />,
    );

    const attested = definition(attestation!.label).value;
    const notFound = definition(redemptionPolicy!.label).value;
    expect(attested.querySelector("svg")).toBeNull();
    expect(notFound.textContent).toBeTruthy();
    expect(attested.textContent).not.toContain(notFound.textContent);
    expect(hasToneClass(attested.firstElementChild, SEVERITY_TONE_CLASS.watch.text)).toBe(true);
    // Who attests, and how often, rides with the value for hover and assistive tech.
    expect(attested.textContent).toContain("BDO Italia");
  });

  it("collapses a review that recorded no disclosure to one line", () => {
    render(
      <RegulatoryStandingCard
        view={buildView({
          genius: {
            ...GENIUS,
            monthlyAttestationPresent: undefined,
            redemptionPolicyPresent: undefined,
            reserveDisclosurePresent: undefined,
          },
        })}
      />,
    );

    expect(screen.getByText("Issuer disclosures")).toBeTruthy();
    for (const disclosure of ISSUER_DISCLOSURES) {
      expect(terms().some((term) => term.textContent?.includes(disclosure.label))).toBe(false);
    }
  });

  it("links a published reserve disclosure to the disclosure itself", () => {
    const url = "https://example.com/reserves";
    render(
      <RegulatoryStandingCard
        view={buildView({ genius: { ...GENIUS, reserveDisclosurePresent: true, reserveDisclosureUrl: url } })}
      />,
    );

    const link = within(definition(reserveDisclosure!.label).value).getByRole("link");
    expect(link.getAttribute("href")).toBe(url);
  });

  it("draws MiCA out-of-scope with the muted status tone it was given", () => {
    const view = buildView({ mica: { status: "out-of-scope" } });
    render(<RegulatoryStandingCard view={view} />);

    const pill = within(definition(view.regimes[0]!.regimeLabel).value).getByText(view.regimes[0]!.status.label);
    expect(hasToneClass(pill, view.regimes[0]!.status.toneClass)).toBe(true);
  });

  it.each([
    { name: "both regimes", coin: { genius: GENIUS, mica: MICA }, disclosures: true },
    { name: "GENIUS only", coin: { genius: GENIUS }, disclosures: true },
    { name: "MiCA only", coin: { mica: MICA }, disclosures: false },
    { name: "MiCA beside an out-of-scope GENIUS review", coin: { genius: OUT_OF_SCOPE_GENIUS, mica: MICA }, disclosures: false },
  ])("renders only the regimes that apply: $name", ({ coin, disclosures }) => {
    const view = buildView(coin);
    render(<RegulatoryStandingCard view={view} />);

    const regimeTerms = terms().filter((term) =>
      view.regimes.some((regime) => term.textContent?.includes(regime.regimeLabel)),
    );
    expect(regimeTerms).toHaveLength(view.regimes.length);
    // Issuer disclosures come from the GENIUS review only.
    expect(screen.queryByText("Issuer disclosures") !== null).toBe(disclosures);
  });

  it("keeps sources, facts and notes inside one closed fold whose count covers them", () => {
    const view = buildView({ genius: GENIUS, mica: MICA });
    const { container } = render(<RegulatoryStandingCard view={view} />);

    const folds = container.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    const fold = folds[0]!;
    expect(fold.open).toBe(false);
    for (const source of view.sources) {
      const link = within(fold).getByRole("link", { name: source.label, hidden: true });
      expect(link.getAttribute("href")).toBe(source.url);
    }
    const factCount = view.regimes.reduce((sum, regime) => sum + regime.facts.length, 0);
    const expected = factCount + (view.reportNote ? 1 : 0) + (view.notes ? 1 : 0) + view.sources.length;
    expect(fold.querySelector("summary")?.textContent).toContain(`(${expected})`);
    // The verdict stays in the always-visible summary layer, outside the fold.
    expect(within(fold).queryByText(view.summary)).toBeNull();
    expect(screen.getByText(view.summary)).toBeTruthy();
  });

  it("renders the in-flow twin in the module grammar with the same fold and the review date", () => {
    const view = buildView({ genius: GENIUS, mica: MICA });
    const { container } = render(<RegulatoryStandingCard view={view} id="jurisdiction" />);

    const section = container.querySelector("section#jurisdiction")!;
    expect(section.hasAttribute("data-evidence-module")).toBe(true);
    expect(within(section as HTMLElement).getByRole("heading", { name: /Regulatory standing/ })).toBeTruthy();
    expect(screen.getByText(view.badgeLabel)).toBeTruthy();
    expect(screen.getByText(view.summary)).toBeTruthy();

    const folds = section.querySelectorAll("details");
    expect(folds).toHaveLength(1);
    const factCount = view.regimes.reduce((sum, regime) => sum + regime.facts.length, 0);
    const expected = factCount + (view.reportNote ? 1 : 0) + (view.notes ? 1 : 0) + view.sources.length;
    expect(folds[0]!.querySelector("summary")?.textContent).toContain(`(${expected})`);
    expect(screen.getByText(`Reviewed ${view.reviewedAt}`)).toBeTruthy();
  });

  it("owns the jurisdiction anchor in flow and stands in for it in the rail", () => {
    const view = buildView({ genius: GENIUS, mica: MICA });
    const { container: inFlow } = render(<RegulatoryStandingCard view={view} id="jurisdiction" />);
    expect(inFlow.querySelector("#jurisdiction")).not.toBeNull();
    expect(inFlow.querySelector("[data-anchor-twin]")).toBeNull();
    cleanup();

    const { container: rail } = render(<RegulatoryStandingCard view={view} anchorTwin />);
    expect(rail.querySelector("#jurisdiction")).toBeNull();
    expect(rail.querySelector('[data-anchor-twin="jurisdiction"]')).not.toBeNull();
    expect(rail.querySelector("[data-evidence-module]")).toBeNull();
  });

  it("renders nothing without a view", () => {
    const { container } = render(<RegulatoryStandingCard view={null} />);
    expect(container.innerHTML).toBe("");
  });
});
