// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import type { ReactNode } from "react";
import {
  EvidenceModule,
  EvidenceStateStrip,
  expandEvidenceModuleFor,
} from "../evidence-module";
import { StablecoinDetailIdentityProvider } from "../module-title";
import { EvidenceFooter } from "../evidence-footer";
import { ModuleDisclosure } from "../module-disclosure";

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

  it("keeps explicit disclosures and evidence full-width when extracted or wrapped in fragments", () => {
    const disclosure = <ModuleDisclosure label="Providers"><p>Provider evidence.</p></ModuleDisclosure>;
    const evidence = <EvidenceFooter reviewed="2026-11-01">Review basis.</EvidenceFooter>;
    const Disclosures = () => disclosure;
    const Evidence = () => evidence;
    const shell = (folds: ReactNode, footer: ReactNode) => (
      <EvidenceModule id="explicit-slots" title="Custody" variant="module" bodyLayout="split"
        visual={<div>Visual summary.</div>} folds={folds} footer={footer}>
        <p>Current state.</p>
      </EvidenceModule>
    );
    const original = renderToString(shell(disclosure, evidence));
    expect(renderToString(shell(<>{disclosure}</>, <>{evidence}</>))).toBe(original);
    expect(renderToString(shell(<Disclosures />, <Evidence />))).toBe(original);
    const { container } = render(shell(<Disclosures />, <Evidence />));
    const body = container.querySelector("#explicit-slots-body")!;
    expect(body.children[0]?.textContent).toBe("Visual summary.Current state.");
    // Folds and footer share the full-width block pinned to the card's foot.
    const foldRun = body.children[1]!;
    expect(foldRun.className).toContain("mt-auto");
    expect(foldRun.children[0]?.tagName).toBe("DETAILS");
    expect(foldRun.children[0]?.textContent).toContain("Provider evidence.");
    expect(foldRun.lastElementChild?.textContent).toContain("Review basis.");
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

  it("names the coin inside the heading while the phone accordion keeps its own name and target", () => {
    render(
      <StablecoinDetailIdentityProvider symbol="BD" logoSrc={undefined}>
        <EvidenceModule
          id="custody"
          title="Custody"
          variant="tile"
          headerRight={<span>Segregated</span>}
          methodology={<button type="button" aria-label="Custody methodology">?</button>}
        >
          <p>Custodian breakdown.</p>
        </EvidenceModule>
      </StablecoinDetailIdentityProvider>,
    );

    const heading = screen.getByRole("heading", { level: 3, name: "BD Custody" });
    const toggle = within(heading).getByRole("button", { name: "Custody" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-controls")).toBe("custody-body");
    expect(document.getElementById("custody-body")?.textContent).toContain("Custodian breakdown.");

    // The help glyph stays outside both the heading and the accordion button.
    const help = screen.getByRole("button", { name: "Custody methodology" });
    expect(heading.contains(help)).toBe(false);
    expect(toggle.contains(help)).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("custody-body")?.textContent).toContain("Custodian breakdown.");
  });

  it("keeps the status chip beside the title, before the phone accordion's chevron", () => {
    const { container } = renderCustodyTile();
    const header = container.querySelector("#custody")!.firstElementChild!;
    const chevron = header.querySelector("svg.lucide-chevron-down")!;
    expect(screen.getByText("Omnibus").compareDocumentPosition(chevron) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // No header row is forced onto its own line: the chips wrap only when they do not fit.
    expect(header.innerHTML).not.toContain("basis-full");
  });

  it("never folds a tile to a bare title: it folds only with a status chip or a folded summary", () => {
    const { unmount } = render(
      <EvidenceModule id="access" title="Access posture" variant="strip">
        <p>Transfer permissionless.</p>
      </EvidenceModule>,
    );
    // No key figure for a folded header: the module stays open on a phone.
    expect(screen.queryByRole("button", { name: "Access posture" })).toBeNull();
    expect(document.getElementById("access")?.hasAttribute("data-expanded")).toBe(false);
    unmount();

    render(
      <EvidenceModule id="backing" title="Backing mechanics" variant="tile" foldedSummary={<span>1.5% loss absorption</span>}>
        <p>Reserve fund over supply.</p>
      </EvidenceModule>,
    );
    expect(screen.getByRole("button", { name: "Backing mechanics" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("1.5% loss absorption")).toBeTruthy();
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

  it("opens on mount when the hash targets a descendant id", () => {
    window.location.hash = "#custody-review-notes";
    renderCustodyTile();

    expect(screen.getByRole("button", { name: "Custody" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("opens on a later hashchange to its own id and ignores other or malformed targets", () => {
    render(
      <>
        <div id="reserves">Reserves</div>
        <EvidenceModule id="custody" title="Custody" variant="tile" headerRight={<span>Segregated</span>}>
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
    // The separator travels with the reason, so a wrapped reason never strands a trailing dot.
    expect(screen.getByText("NAV tokens accrue by design").textContent).toMatch(/^·/);
    expect(container.textContent?.replace("NAV tokens accrue by design", "")).not.toBe(notReviewedText);
  });
});
