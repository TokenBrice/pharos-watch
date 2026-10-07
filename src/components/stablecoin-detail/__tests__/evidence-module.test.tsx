// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  EvidenceModule,
  EvidenceStateStrip,
  expandEvidenceModuleFor,
} from "../evidence-module";
import { ModuleDisclosure } from "../module-disclosure";

/** True when `later` comes after `earlier` in document order. */
function follows(earlier: Node, later: Node) {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function setHash(hash: string) {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event("hashchange"));
  });
}

function stubDesktopViewport() {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === "(min-width: 768px)",
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

function renderCustodyTile(props: { collapsibleOnMobile?: boolean } = {}) {
  return render(
    <EvidenceModule id="custody" title="Custody" variant="tile" headerRight={<span>Omnibus</span>} {...props}>
      <p>Custodian breakdown.</p>
      <div id="custody-review-notes">Reviewer notes.</div>
    </EvidenceModule>,
  );
}

describe("EvidenceModule", () => {
  afterEach(() => {
    window.location.hash = "";
    Reflect.deleteProperty(window, "matchMedia");
  });

  it("folds a tile below md as an accordion whose button controls the body", () => {
    renderCustodyTile();

    const toggle = screen.getByRole("button", { name: "Custody" });
    expect(toggle.closest("h3")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body?.textContent).toContain("Custodian breakdown.");

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("names the section by its heading and keeps the status chip outside the toggle", () => {
    renderCustodyTile();

    const section = screen.getByRole("region", { name: "Custody" });
    expect(section.id).toBe("custody");
    expect(screen.getByRole("button", { name: "Custody" }).textContent).not.toContain("Omnibus");
  });

  it("never folds a full-width module unless asked to", () => {
    render(
      <EvidenceModule title="Mint Authority" variant="module">
        <p>Mint rail.</p>
      </EvidenceModule>,
    );

    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("heading", { level: 3, name: "Mint Authority" })).toBeTruthy();
    expect(screen.getByText("Mint rail.")).toBeTruthy();
  });

  it("renders no toggle on a desktop viewport, where the body is always open", () => {
    stubDesktopViewport();
    renderCustodyTile();

    expect(screen.queryByRole("button", { name: "Custody" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Custody" })).toBeTruthy();
    expect(screen.getByText("Custodian breakdown.")).toBeTruthy();
  });

  it("honours an h2 heading level for modules outside a pillar board", () => {
    render(
      <EvidenceModule title="DEWS" variant="module" headingLevel="h2">
        <p>Stress signal.</p>
      </EvidenceModule>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "DEWS" })).toBeTruthy();
  });

  it("opens on mount when the hash targets a descendant id", () => {
    window.location.hash = "#custody-review-notes";
    renderCustodyTile();

    expect(screen.getByRole("button", { name: "Custody" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens on a later hashchange to its own id and ignores other or malformed targets", () => {
    render(
      <>
        <div id="reserves">Reserves</div>
        <EvidenceModule id="custody" title="Custody" variant="tile">
          <p>Custodian breakdown.</p>
        </EvidenceModule>
      </>,
    );
    const toggle = screen.getByRole("button", { name: "Custody" });

    setHash("#%E0%A4");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    setHash("#reserves");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    setHash("#custody");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("expandEvidenceModuleFor reveals the enclosing module synchronously and syncs its toggle", () => {
    const { container } = renderCustodyTile();
    const section = container.querySelector("section");
    const target = document.getElementById("custody-review-notes");

    act(() => {
      expandEvidenceModuleFor(target);
      // The CSS reveal must not wait for a React render: callers scroll next.
      expect(section?.getAttribute("data-expanded")).toBe("true");
    });

    expect(screen.getByRole("button", { name: "Custody" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("expandEvidenceModuleFor ignores targets outside any module and modules that never fold", () => {
    const { container } = render(
      <>
        <p id="outside">Outside</p>
        <EvidenceModule title="Mint Authority" variant="module">
          <p id="mint-inside">Mint rail.</p>
        </EvidenceModule>
      </>,
    );

    expect(() => expandEvidenceModuleFor(document.getElementById("outside"))).not.toThrow();
    expect(() => expandEvidenceModuleFor(null)).not.toThrow();
    expandEvidenceModuleFor(document.getElementById("mint-inside"));
    expect(container.querySelector("section")?.hasAttribute("data-expanded")).toBe(false);
  });

  it("renders the strip form for a tile flagged as a lone last tile", () => {
    const { container } = render(
      <EvidenceModule title="Freeze & seizure" variant="tile" stripForm>
        <p>Freeze facts.</p>
      </EvidenceModule>,
    );

    expect(container.querySelector("section")?.getAttribute("data-evidence-module")).toBe("strip");
    // Strip form folds on phones like the tile it replaces.
    expect(screen.getByRole("button", { name: "Freeze & seizure" })).toBeTruthy();
  });

  it("splits a strip into the visual beside verdict, chips and facts, with the footer underneath", () => {
    render(
      <EvidenceModule
        title="Freeze & seizure"
        variant="tile"
        stripForm
        visual={<div>Power to scope rail</div>}
        verdict="A reviewed control can freeze this token."
        chipRow={<span>Sourced review</span>}
        footer={<p>Reviewed 2026-07-22</p>}
      >
        <p>Reviewed deployments</p>
      </EvidenceModule>,
    );

    const visualColumn = screen.getByText("Power to scope rail").parentElement!;
    const verdict = screen.getByText("A reviewed control can freeze this token.");
    const facts = screen.getByText("Reviewed deployments");
    const footer = screen.getByText("Reviewed 2026-07-22");
    const columns = visualColumn.parentElement!;

    expect(visualColumn.contains(verdict)).toBe(false);
    expect(verdict.parentElement).toBe(facts.parentElement);
    expect(columns.contains(verdict)).toBe(true);
    // The footer spans the module: it sits below both columns, last in the body.
    expect(columns.contains(footer)).toBe(false);
    expect(footer.parentElement?.lastElementChild).toBe(footer);
  });

  it("stacks a strip without a visual in one column, footer last", () => {
    render(
      <EvidenceModule
        title="Custody"
        variant="tile"
        stripForm
        verdict="Custody structure undisclosed."
        footer={<p>Reviewed 2026-10-01</p>}
      >
        <p>Providers</p>
      </EvidenceModule>,
    );

    const verdict = screen.getByText("Custody structure undisclosed.");
    const body = verdict.parentElement!;
    expect(body.contains(screen.getByText("Providers"))).toBe(true);
    expect(body.lastElementChild?.textContent).toBe("Reviewed 2026-10-01");
  });

  it("keeps a module body in one column unless it opts in to the split", () => {
    render(
      <EvidenceModule title="Redemption route" variant="module" visual={<div>Route rail</div>} verdict="Route verdict.">
        <p>Capacity fold</p>
      </EvidenceModule>,
    );

    const body = screen.getByText("Route rail").parentElement!;
    expect(body.contains(screen.getByText("Route verdict."))).toBe(true);
    expect(screen.getByText("Route verdict.").parentElement).toBe(body);
  });

  it("folds the footer away with the body on phones", () => {
    render(
      <EvidenceModule id="custody" title="Custody" variant="tile" footer={<p>Reviewed 2026-09-04</p>}>
        <p>Custodian breakdown.</p>
      </EvidenceModule>,
    );

    const toggle = screen.getByRole("button", { name: "Custody" });
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body?.contains(screen.getByText("Reviewed 2026-09-04"))).toBe(true);
  });

  it("splits only the summary layer and runs every fold full width after it, footer last", () => {
    render(
      <EvidenceModule
        title="Mint Authority"
        variant="module"
        bodyLayout="split"
        visual={<div>Band ladder</div>}
        verdict="Governed mint."
        folds={
          <div>
            <ModuleDisclosure label="Scoring breakdown">
              <p>Derived posture</p>
            </ModuleDisclosure>
            <ModuleDisclosure label="Primary controls">
              <p>Direct minter</p>
            </ModuleDisclosure>
          </div>
        }
        footer={<p>Reviewed 2026-10-04</p>}
      >
        <p>Mint path facts</p>
      </EvidenceModule>,
    );

    const summaryLayer = screen.getByText("Band ladder").parentElement!.parentElement!;
    const breakdown = screen.getByText("Scoring breakdown").closest("details")!;
    const controls = screen.getByText("Primary controls").closest("details")!;
    const footer = screen.getByText("Reviewed 2026-10-04");

    expect(summaryLayer.contains(screen.getByText("Governed mint."))).toBe(true);
    expect(summaryLayer.contains(screen.getByText("Mint path facts"))).toBe(true);
    for (const fold of [breakdown, controls, footer]) expect(summaryLayer.contains(fold)).toBe(false);
    // One place: the folds and the footer share the body with the summary layer.
    expect(controls.parentElement?.parentElement).toBe(summaryLayer.parentElement);
    expect(footer.parentElement).toBe(summaryLayer.parentElement);
    expect(follows(summaryLayer, breakdown)).toBe(true);
    expect(follows(breakdown, controls)).toBe(true);
    expect(follows(controls, footer)).toBe(true);
  });

  it("lifts a disclosure passed as a child out of the split into the fold run", () => {
    render(
      <EvidenceModule
        title="Custody"
        variant="tile"
        stripForm
        visual={<div>Protection meter</div>}
        verdict="Segregated custody."
        footer={<p>Reviewed 2026-10-01</p>}
      >
        <p>Held by</p>
        <ModuleDisclosure label="Providers" count={2}>
          <p>Custodian A</p>
        </ModuleDisclosure>
      </EvidenceModule>,
    );

    const summaryLayer = screen.getByText("Protection meter").parentElement!.parentElement!;
    const providers = screen.getByText("Providers").closest("details")!;
    const footer = screen.getByText("Reviewed 2026-10-01");

    expect(summaryLayer.contains(screen.getByText("Held by"))).toBe(true);
    expect(summaryLayer.contains(providers)).toBe(false);
    expect(providers.parentElement).toBe(footer.parentElement);
    expect(follows(providers, footer)).toBe(true);
  });

  it("renders every header chip in order, outside the heading", () => {
    render(
      <EvidenceModule
        title="Bridging & deployments"
        variant="tile"
        headerRight={
          <>
            <span>Mostly validator network</span>
            <span>Diagnostic</span>
          </>
        }
      />,
    );

    const heading = screen.getByRole("heading", { name: "Bridging & deployments" });
    const primary = screen.getByText("Mostly validator network");
    const secondary = screen.getByText("Diagnostic");

    expect(heading.contains(primary)).toBe(false);
    expect(heading.contains(secondary)).toBe(false);
    expect(follows(primary, secondary)).toBe(true);
  });
});

describe("EvidenceStateStrip", () => {
  it("states a missing review under the module's own title", () => {
    const { container } = render(
      <EvidenceStateStrip id="jurisdiction" title="Regulatory standing" state="not-reviewed" density="rail" />,
    );

    const section = screen.getByRole("region", { name: "Regulatory standing" });
    expect(section.id).toBe("jurisdiction");
    expect(section.getAttribute("data-evidence-state")).toBe("not-reviewed");
    expect(screen.getByRole("heading", { level: 2, name: "Regulatory standing" })).toBeTruthy();
    expect(container.textContent?.trim().length).toBeGreaterThan("Regulatory standing".length);
  });

  it("states non-applicability with its rationale, distinct from a missing review", () => {
    const notReviewed = render(<EvidenceStateStrip title="DEWS" state="not-reviewed" density="main" />);
    const notReviewedText = notReviewed.container.textContent;
    notReviewed.unmount();

    const { container } = render(
      <EvidenceStateStrip title="DEWS" state="not-applicable" reason="NAV tokens accrue by design" density="main" />,
    );

    expect(screen.getByRole("heading", { level: 3, name: "DEWS" })).toBeTruthy();
    expect(container.querySelector("section")?.getAttribute("data-evidence-state")).toBe("not-applicable");
    expect(screen.getByText("NAV tokens accrue by design")).toBeTruthy();
    expect(container.textContent?.replace("NAV tokens accrue by design", "")).not.toBe(notReviewedText);
  });
});
