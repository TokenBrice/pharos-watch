// @vitest-environment jsdom

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CompliancePage, { metadata } from "./page";

vi.mock("./client", () => ({ ComplianceClient: () => <div data-testid="compliance-client" /> }));

describe("CompliancePage summary copy", () => {
  it("names the active-only MiCA population and the authorization rate's real base", () => {
    const html = renderToStaticMarkup(<CompliancePage />);

    expect(html).toContain("MiCA-authorized active stablecoins");
    expect(html).toMatch(/of \d+ active stablecoins assessed for MiCA/);
    expect(html).toContain("Authorized share of active MiCA rows");
    expect(html).not.toContain("EU-assessed");

    const description = String(metadata.description);
    expect(description).toMatch(/of \d+ active stablecoins assessed for MiCA hold MiCA authorization/);
    expect(description).not.toContain("EU-assessed");
    expect(String(metadata.title)).toContain("Active MiCA-Authorized");
  });
});
