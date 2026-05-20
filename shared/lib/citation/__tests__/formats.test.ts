import { describe, expect, it } from "vitest";

import {
  deriveCiteKey,
  formatAPA7,
  formatBibTeX,
  formatChicago,
  formatPlain,
  type CitationInput,
} from "../formats";

const coinCitation: CitationInput = {
  title: "USDC (Circle) — Stablecoin Analytics",
  url: "https://pharos.watch/stablecoin/usdc-circle/",
  urn: "urn:pharos:coin:usdc-circle",
  accessedDate: "2026-05-16",
};

const methodologyCitation: CitationInput = {
  title: "Pharos DEWS Methodology",
  url: "https://pharos.watch/methodology/depeg-changelog/",
  urn: "urn:pharos:methodology:dews@v4.2",
  version: "v4.2",
  accessedDate: "2026-05-16",
};

describe("deriveCiteKey", () => {
  it("strips the urn:pharos: prefix and replaces separators", () => {
    expect(deriveCiteKey("urn:pharos:coin:usdc-circle")).toBe("coin_usdc-circle");
  });

  it("retains version qualifier separated by underscore", () => {
    expect(deriveCiteKey("urn:pharos:methodology:dews@v4.2")).toBe("methodology_dews_v4-2");
  });
});

describe("formatBibTeX", () => {
  it("renders a coin citation", () => {
    const bib = formatBibTeX(coinCitation);
    expect(bib).toContain("@misc{coin_usdc-circle,");
    expect(bib).toContain("author       = {Pharos Watch},");
    expect(bib).toContain("year         = {2026},");
    expect(bib).toContain("month        = {may},");
    expect(bib).toContain("howpublished = {\\url{https://pharos.watch/stablecoin/usdc-circle/}},");
    expect(bib).toContain("urldate      = {2026-05-16}");
    expect(bib).toContain("note         = {Accessed: 2026-05-16; urn:pharos:coin:usdc-circle},");
  });

  it("includes the version field when provided", () => {
    const bib = formatBibTeX(methodologyCitation);
    expect(bib).toContain("version      = {v4.2},");
  });

  it("escapes BibTeX-reserved characters in the title", () => {
    const bib = formatBibTeX({
      ...coinCitation,
      title: "100% & free_money",
    });
    expect(bib).toContain("title        = {100\\% \\& free\\_money},");
  });

  it("rejects malformed accessedDate", () => {
    expect(() => formatBibTeX({ ...coinCitation, accessedDate: "May 16, 2026" })).toThrow();
  });
});

describe("formatAPA7", () => {
  it("renders a coin citation", () => {
    expect(formatAPA7(coinCitation)).toBe(
      "Pharos Watch. (2026, May 16). USDC (Circle) — Stablecoin Analytics. Retrieved 2026-05-16, from https://pharos.watch/stablecoin/usdc-circle/",
    );
  });

  it("includes version when provided", () => {
    expect(formatAPA7(methodologyCitation)).toBe(
      "Pharos Watch. (2026, May 16). Pharos DEWS Methodology (v4.2). Retrieved 2026-05-16, from https://pharos.watch/methodology/depeg-changelog/",
    );
  });
});

describe("formatChicago", () => {
  it("renders a coin citation", () => {
    expect(formatChicago(coinCitation)).toBe(
      'Pharos Watch. 2026. "USDC (Circle) — Stablecoin Analytics." Pharos Watch. Accessed 2026-05-16. https://pharos.watch/stablecoin/usdc-circle/.',
    );
  });

  it("includes version sentence when provided", () => {
    expect(formatChicago(methodologyCitation)).toBe(
      'Pharos Watch. 2026. "Pharos DEWS Methodology." Version v4.2. Pharos Watch. Accessed 2026-05-16. https://pharos.watch/methodology/depeg-changelog/.',
    );
  });
});

describe("formatPlain", () => {
  it("renders a one-liner with URL and URN", () => {
    expect(formatPlain(coinCitation)).toBe(
      "USDC (Circle) — Stablecoin Analytics — https://pharos.watch/stablecoin/usdc-circle/ — urn:pharos:coin:usdc-circle",
    );
  });

  it("includes version parenthetical when provided", () => {
    expect(formatPlain(methodologyCitation)).toBe(
      "Pharos DEWS Methodology (v4.2) — https://pharos.watch/methodology/depeg-changelog/ — urn:pharos:methodology:dews@v4.2",
    );
  });
});
