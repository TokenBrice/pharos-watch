import { describe, expect, it } from "vitest";

import { formatPharosUrn, parsePharosUrn } from "../urn";

describe("formatPharosUrn", () => {
  it("formats coin URN without qualifier", () => {
    expect(formatPharosUrn("coin", "usdc-circle")).toBe("urn:pharos:coin:usdc-circle");
  });

  it("formats methodology URN with version qualifier", () => {
    expect(formatPharosUrn("methodology", "safety-score", "v7.2")).toBe(
      "urn:pharos:methodology:safety-score@v7.2",
    );
  });

  it("formats coin URN with date qualifier", () => {
    expect(formatPharosUrn("coin", "usdc-circle", "2026-05-16")).toBe(
      "urn:pharos:coin:usdc-circle@2026-05-16",
    );
  });

  it("formats depeg-event URN", () => {
    expect(formatPharosUrn("depeg-event", "usdc-2023-03-11")).toBe(
      "urn:pharos:depeg-event:usdc-2023-03-11",
    );
  });

  it("rejects uppercase id", () => {
    expect(() => formatPharosUrn("coin", "USDC")).toThrow();
  });

  it("rejects id with underscore", () => {
    expect(() => formatPharosUrn("coin", "usdc_circle")).toThrow();
  });

  it("rejects empty id", () => {
    expect(() => formatPharosUrn("coin", "")).toThrow();
  });

  it("rejects unknown entity class", () => {
    // @ts-expect-error testing runtime guard
    expect(() => formatPharosUrn("rogue", "usdc-circle")).toThrow();
  });

  it("rejects qualifier with invalid characters", () => {
    expect(() => formatPharosUrn("methodology", "safety-score", "v7 2")).toThrow();
  });
});

describe("parsePharosUrn", () => {
  it("parses coin URN without qualifier", () => {
    expect(parsePharosUrn("urn:pharos:coin:usdc-circle")).toEqual({
      entityClass: "coin",
      id: "usdc-circle",
    });
  });

  it("parses methodology URN with version qualifier", () => {
    expect(parsePharosUrn("urn:pharos:methodology:safety-score@v7.2")).toEqual({
      entityClass: "methodology",
      id: "safety-score",
      qualifier: "v7.2",
    });
  });

  it("parses depeg-event URN", () => {
    expect(parsePharosUrn("urn:pharos:depeg-event:usdc-2023-03-11")).toEqual({
      entityClass: "depeg-event",
      id: "usdc-2023-03-11",
    });
  });

  it("rejects missing prefix", () => {
    expect(parsePharosUrn("pharos:coin:usdc-circle")).toBeNull();
  });

  it("rejects unknown entity class", () => {
    expect(parsePharosUrn("urn:pharos:rogue:usdc-circle")).toBeNull();
  });

  it("rejects uppercase id", () => {
    expect(parsePharosUrn("urn:pharos:coin:USDC")).toBeNull();
  });

  it("rejects underscore in id", () => {
    expect(parsePharosUrn("urn:pharos:coin:usdc_circle")).toBeNull();
  });

  it("rejects empty qualifier", () => {
    expect(parsePharosUrn("urn:pharos:methodology:safety-score@")).toBeNull();
  });

  it("rejects empty id", () => {
    expect(parsePharosUrn("urn:pharos:coin:")).toBeNull();
  });

  it("rejects non-string input", () => {
    // @ts-expect-error testing runtime guard
    expect(parsePharosUrn(123)).toBeNull();
  });
});

describe("round-trip", () => {
  const cases: Array<{ entityClass: Parameters<typeof formatPharosUrn>[0]; id: string; qualifier?: string }> = [
    { entityClass: "coin", id: "usdc-circle" },
    { entityClass: "coin", id: "usdc-circle", qualifier: "2026-05-16" },
    { entityClass: "methodology", id: "dews", qualifier: "v4.2" },
    { entityClass: "depeg-event", id: "usdc-2023-03-11" },
    { entityClass: "depeg-report", id: "usdc-circle-2023-03" },
    { entityClass: "digest", id: "2026-05-16" },
    { entityClass: "cemetery", id: "basis-cash" },
    { entityClass: "dataset", id: "stablecoin-cemetery" },
    { entityClass: "snapshot", id: "2026-05-16" },
  ];

  for (const { entityClass, id, qualifier } of cases) {
    it(`round-trips ${entityClass}:${id}${qualifier ? `@${qualifier}` : ""}`, () => {
      const urn = formatPharosUrn(entityClass, id, qualifier);
      const parsed = parsePharosUrn(urn);
      expect(parsed).toEqual(qualifier ? { entityClass, id, qualifier } : { entityClass, id });
    });
  }
});
