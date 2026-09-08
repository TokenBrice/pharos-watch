import { describe, expect, it } from "vitest";

import { formatPharosUrn, parsePharosUrn } from "../urn";

describe("formatPharosUrn", () => {
  it.each([
    ["coin", "usdc-circle", undefined, "urn:pharos:coin:usdc-circle"],
    ["methodology", "safety-score", "v7.2", "urn:pharos:methodology:safety-score@v7.2"],
    ["coin", "usdc-circle", "2026-05-16", "urn:pharos:coin:usdc-circle@2026-05-16"],
    ["depeg-event", "usdc-2023-03-11", undefined, "urn:pharos:depeg-event:usdc-2023-03-11"],
  ] as const)("formats %s:%s qualifier %s", (entityClass, id, qualifier, expected) => {
    expect(formatPharosUrn(entityClass, id, qualifier)).toBe(expected);
  });

  it.each(["USDC", "usdc_circle", ""])("rejects malformed id %j", (id) => {
    expect(() => formatPharosUrn("coin", id)).toThrow();
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
  it.each([
    ["urn:pharos:coin:usdc-circle", { entityClass: "coin", id: "usdc-circle" }],
    ["urn:pharos:methodology:safety-score@v7.2", { entityClass: "methodology", id: "safety-score", qualifier: "v7.2" }],
    ["urn:pharos:depeg-event:usdc-2023-03-11", { entityClass: "depeg-event", id: "usdc-2023-03-11" }],
  ] as const)("parses %s", (urn, expected) => {
    expect(parsePharosUrn(urn)).toEqual(expected);
  });

  it.each([
    "pharos:coin:usdc-circle",
    "urn:pharos:rogue:usdc-circle",
    "urn:pharos:coin:USDC",
    "urn:pharos:coin:usdc_circle",
    "urn:pharos:methodology:safety-score@",
    "urn:pharos:coin:",
  ])("rejects malformed URN %j", (urn) => {
    expect(parsePharosUrn(urn)).toBeNull();
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

  it.each(cases)("round-trips $entityClass:$id qualifier $qualifier", ({ entityClass, id, qualifier }) => {
    const urn = formatPharosUrn(entityClass, id, qualifier);
    expect(parsePharosUrn(urn)).toEqual(qualifier ? { entityClass, id, qualifier } : { entityClass, id });
  });
});
