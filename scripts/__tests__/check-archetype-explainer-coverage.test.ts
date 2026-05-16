import { describe, expect, it, vi } from "vitest";

describe("validateArchetypeExplainerCoverage", () => {
  it("passes against the current repo state", async () => {
    vi.resetModules();
    const mod = await import("../ci/check-archetype-explainer-coverage");
    const result = mod.validateArchetypeExplainerCoverage();
    expect(result.findings).toEqual([]);
    expect(result.failedArchetypes.size).toBe(0);
  });

  it("reports a finding when a MECHANISM_ARCHETYPE_LABELS entry is empty", async () => {
    vi.resetModules();
    vi.doMock("../../shared/lib/classification", async () => {
      const actual = await vi.importActual<typeof import("../../shared/lib/classification")>(
        "../../shared/lib/classification",
      );
      return {
        ...actual,
        MECHANISM_ARCHETYPE_LABELS: {
          ...actual.MECHANISM_ARCHETYPE_LABELS,
          "fiat-cash": "",
        },
      };
    });

    const mod = await import("../ci/check-archetype-explainer-coverage");
    const result = mod.validateArchetypeExplainerCoverage();
    expect(result.failedArchetypes.has("fiat-cash")).toBe(true);
    const fiatFindings = result.findings.filter((f) => f.archetype === "fiat-cash");
    expect(fiatFindings.some((f) => f.message.includes("MECHANISM_ARCHETYPE_LABELS"))).toBe(true);

    vi.doUnmock("../../shared/lib/classification");
  });

  it("reports a finding when a MECHANISM_ARCHETYPE_ONE_LINERS entry is empty", async () => {
    vi.resetModules();
    vi.doMock("../../shared/lib/classification", async () => {
      const actual = await vi.importActual<typeof import("../../shared/lib/classification")>(
        "../../shared/lib/classification",
      );
      return {
        ...actual,
        MECHANISM_ARCHETYPE_ONE_LINERS: {
          ...actual.MECHANISM_ARCHETYPE_ONE_LINERS,
          cdp: "",
        },
      };
    });

    const mod = await import("../ci/check-archetype-explainer-coverage");
    const result = mod.validateArchetypeExplainerCoverage();
    expect(result.failedArchetypes.has("cdp")).toBe(true);
    const cdpFindings = result.findings.filter((f) => f.archetype === "cdp");
    expect(cdpFindings.some((f) => f.message.includes("MECHANISM_ARCHETYPE_ONE_LINERS"))).toBe(true);

    vi.doUnmock("../../shared/lib/classification");
  });

  it("reports a finding when ARCHETYPE_CONTENT.headline still starts with STUB", async () => {
    vi.resetModules();
    vi.doMock("../../src/app/learn/mechanisms/content", async () => {
      const actual = await vi.importActual<typeof import("../../src/app/learn/mechanisms/content")>(
        "../../src/app/learn/mechanisms/content",
      );
      return {
        ...actual,
        ARCHETYPE_CONTENT: {
          ...actual.ARCHETYPE_CONTENT,
          algorithmic: {
            ...actual.ARCHETYPE_CONTENT.algorithmic,
            headline: "STUB — algorithmic headline",
          },
        },
      };
    });

    const mod = await import("../ci/check-archetype-explainer-coverage");
    const result = mod.validateArchetypeExplainerCoverage();
    expect(result.failedArchetypes.has("algorithmic")).toBe(true);
    const algFindings = result.findings.filter((f) => f.archetype === "algorithmic");
    expect(algFindings.some((f) => f.message.includes("placeholder copy"))).toBe(true);

    vi.doUnmock("../../src/app/learn/mechanisms/content");
  });

  it("reports a finding when representativeCoins references an unknown coinId", async () => {
    vi.resetModules();
    vi.doMock("../../src/app/learn/mechanisms/content", async () => {
      const actual = await vi.importActual<typeof import("../../src/app/learn/mechanisms/content")>(
        "../../src/app/learn/mechanisms/content",
      );
      const base = actual.ARCHETYPE_CONTENT.tbill;
      return {
        ...actual,
        ARCHETYPE_CONTENT: {
          ...actual.ARCHETYPE_CONTENT,
          tbill: {
            ...base,
            representativeCoins: [
              { coinId: "this-coin-does-not-exist", note: "synthetic test value" },
            ],
          },
        },
      };
    });

    const mod = await import("../ci/check-archetype-explainer-coverage");
    const result = mod.validateArchetypeExplainerCoverage();
    expect(result.failedArchetypes.has("tbill")).toBe(true);
    const tbillFindings = result.findings.filter((f) => f.archetype === "tbill");
    expect(
      tbillFindings.some((f) => f.message.includes("this-coin-does-not-exist")),
    ).toBe(true);

    vi.doUnmock("../../src/app/learn/mechanisms/content");
  });
});
