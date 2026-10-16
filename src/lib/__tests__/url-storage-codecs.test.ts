// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  parseArraySearchParam,
  parseBooleanSearchParam,
  parseBoundedNumberSearchParam,
  parseEnumSearchParam,
  parseStablecoinIdSearchParam,
  readJsonStorageValue,
  writeJsonStorageValue,
} from "../url-storage-codecs";

describe("URL search codecs", () => {
  it.each([
    { query: "?grade=a", normalize: (value: string) => value.toUpperCase(), expected: "A" },
    { query: "?grade=c", normalize: undefined, expected: null },
  ])("parses enum $query with its normalization policy", ({ query, normalize, expected }) => {
    const result = parseEnumSearchParam(query, "grade", ["A", "B"] as const, { normalize });
    if (expected === null) expect(result).toBeNull();
    else expect(result).toBe(expected);
  });

  it.each([
    { query: "?limit=10", options: { min: 1, max: 20, integer: true }, expected: 10 },
    { query: "?limit=21", options: { min: 1, max: 20, fallback: 5 }, expected: 5 },
  ])("parses bounded numeric $query", ({ query, options, expected }) => {
    expect(parseBoundedNumberSearchParam(query, "limit", options)).toBe(expected);
  });

  it.each([
    { query: "?dryRun=1", fallback: undefined, expected: true },
    { query: "?dryRun=nope", fallback: false, expected: false },
  ])("parses boolean $query", ({ query, fallback, expected }) => {
    expect(parseBooleanSearchParam(query, "dryRun", fallback)).toBe(expected);
  });

  it("parses arrays and stablecoin IDs through caller-provided decoders", () => {
    expect(parseArraySearchParam("?coins=a,b,,c", "coins", (value) => value || null)).toEqual(["a", "b", "c"]);
    expect(parseStablecoinIdSearchParam("?coin=USDC", "coin", {
      decode: (value) => value.toLowerCase(),
      isKnownCoinId: (value) => value === "usdc",
    })).toBe("usdc");
    expect(parseStablecoinIdSearchParam("?coin=DAI", "coin", {
      isKnownCoinId: (value) => value === "usdc",
    })).toBeNull();
  });

});

describe("JSON storage codecs", () => {
  it("reads and writes JSON storage values with safe fallback", () => {
    writeJsonStorageValue(window.localStorage, "codec-test", [{ id: "ok" }]);

    expect(readJsonStorageValue(
      window.localStorage,
      "codec-test",
      (value) => Array.isArray(value) ? value.length : null,
      0,
    )).toBe(1);

    window.localStorage.setItem("codec-test", "{");
    expect(readJsonStorageValue(window.localStorage, "codec-test", () => 1, 0)).toBe(0);
  });
});
