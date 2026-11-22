// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CompliancePage, { metadata } from "./page";

vi.mock("./client", () => ({ ComplianceClient: () => <div data-testid="compliance-client" /> }));

describe("CompliancePage summary copy", () => {
  it("reports truthful in-scope MiCA share, GENIUS active signals, and folded methodology disclosure", () => {
    const html = renderToStaticMarkup(<CompliancePage />);

    expect(html).toContain("MiCA Authorized");
    expect(html).toMatch(/\d+% of \d+ in-scope/);
    expect(html).toMatch(/of \d+ active stablecoins assessed for MiCA/);
    expect(html).toContain("GENIUS Active Signals");
    expect(html).toMatch(/href="\/compliance\/?\?regime=genius#data"/);
    expect(html).not.toMatch(/href="\/compliance\/?\?regime=genius&amp;status=[^"]+#data"/);
    expect(html).not.toContain("Authorized share of active MiCA rows");
    expect(html).not.toContain("Assessed regime rows");
    expect(html).not.toContain("EU-assessed");

    const detailsStart = html.indexOf("<details");
    expect(detailsStart).toBeGreaterThan(-1);
    expect(html.indexOf("How to read status")).toBeGreaterThan(detailsStart);
    expect(html.indexOf("GENIUS regime state")).toBeGreaterThan(detailsStart);

    const description = String(metadata.description);
    expect(description).toMatch(/of \d+ in-scope active stablecoins \(\d+ assessed\) hold MiCA authorization/);
    expect(description).not.toContain("EU-assessed");
    expect(String(metadata.title)).toContain("Active MiCA-Authorized");
  });
});
